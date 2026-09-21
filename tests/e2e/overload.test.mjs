import assert from 'node:assert/strict';
import test from 'node:test';
import { fullStack } from './fixture.mjs';
import { publicCatalogFixture } from '../helpers/public-catalog.mjs';
import { eventually } from '../helpers/eventually.mjs';

test(
  'the full SSR BFF Catalog path sheds blocked work, recovers and exposes BFF failure',
  { timeout: 120000 },
  async () => {
    const stack = await fullStack({
      httpConcurrency: 1,
      gatewayLimits: { apiConcurrent: 2, ssrConcurrent: 1, apiRequests: 1000, ssrRequests: 1000 },
    });
    let fixture, first;
    try {
      fixture = await publicCatalogFixture(stack);
      const html = await (await fetch(stack.origin + '/')).text();
      assert.match(html, /EF-111 synthetic event 11/);
      await fixture.db.query('BEGIN');
      await fixture.db.query('LOCK TABLE "PublicEvent" IN ACCESS EXCLUSIVE MODE');
      first = fetch(stack.origin + '/api/v1/events', { signal: AbortSignal.timeout(8000) });
      await eventually(
        async () => {
          const result = await fixture.db.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'",
          );
          return result.rows[0].n;
        },
        (count) => count > 0,
      );
      const rejected = await Promise.all(
        Array.from({ length: 8 }, () =>
          fetch(stack.origin + '/api/v1/events', { signal: AbortSignal.timeout(2000) }),
        ),
      );
      for (const response of rejected) {
        assert.equal(response.status, 503);
        assert.ok(Number(response.headers.get('retry-after')) > 0);
        assert.equal((await response.json()).retryable, true);
      }
      for (const origin of [stack.origin, stack.bff, stack.catalog])
        assert.equal((await fetch(origin + '/health/ready')).status, 200);
      await fixture.db.query('ROLLBACK');
      const response = await first;
      assert.equal(response.status, 200);
      assert.equal((await response.json()).events.length, 12);
      assert.match(await (await fetch(stack.origin + '/')).text(), /EF-111 synthetic event 11/);
      await stack.stopBff();
      assert.equal((await fetch(stack.catalog + '/api/v1/events')).status, 200);
      assert.match(await (await fetch(stack.origin + '/')).text(), /Каталог временно недоступен/);
    } finally {
      if (fixture) {
        await fixture.db.query('ROLLBACK');
        await fixture.close();
      }
      await first?.catch(() => {});
      await stack.close();
    }
  },
);
