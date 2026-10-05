import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createApplication } from '../../packages/service-runtime/dist/index.js';
import { readTrace, traceSpans } from '../helpers/traces.mjs';

const require = createRequire(
  new URL('../../packages/service-runtime/package.json', import.meta.url),
);
const { Module, Controller, Get, Param, Req } = require('@nestjs/common');

test('concurrent Nest requests propagate separate traces through internal fetch and redact failed requests', async () => {
  const keys = [
    'EVENTFLOW_TELEMETRY_ENABLED',
    'EVENTFLOW_TRACE_SAMPLE_RATIO',
    'BOOKING_URL',
    'EVENTFLOW_ENVIRONMENT',
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.EVENTFLOW_TELEMETRY_ENABLED = 'true';
  process.env.EVENTFLOW_ENVIRONMENT = 'test';
  process.env.EVENTFLOW_TRACE_SAMPLE_RATIO = '1';
  let downstream, upstream;
  try {
    class Upstream {
      async read(id, request) {
        assert.equal(request.headers.authorization, 'Bearer private-token');
        assert.equal(request.headers.baggage, undefined);
        await delay(id === 'slow' ? 30 : 5);
        if (id === 'broken') throw new Error('private-provider-exception');
        return { ok: true };
      }
    }
    Controller('read')(Upstream);
    Get(':id')(
      Upstream.prototype,
      'read',
      Object.getOwnPropertyDescriptor(Upstream.prototype, 'read'),
    );
    Param('id')(Upstream.prototype, 'read', 0);
    Req()(Upstream.prototype, 'read', 1);
    class UpstreamModule {}
    Module({ controllers: [Upstream] })(UpstreamModule);
    upstream = await createApplication(UpstreamModule, { name: 'booking' });
    upstream.useLogger(false);
    await upstream.listen(0, '127.0.0.1');
    const target = await upstream.getUrl();
    process.env.BOOKING_URL = target;
    class Downstream {
      async proxy(id) {
        const response = await fetch(`${target}/read/${id}?secret=private-query`, {
          headers: { authorization: 'Bearer private-token', baggage: 'email=private-email' },
        });
        if (!response.ok) throw new Error('private-upstream-exception');
        return response.json();
      }
    }
    Controller('proxy')(Downstream);
    Get(':id')(
      Downstream.prototype,
      'proxy',
      Object.getOwnPropertyDescriptor(Downstream.prototype, 'proxy'),
    );
    Param('id')(Downstream.prototype, 'proxy', 0);
    class DownstreamModule {}
    Module({ controllers: [Downstream] })(DownstreamModule);
    downstream = await createApplication(DownstreamModule, { name: 'bff' });
    downstream.useLogger(false);
    await downstream.listen(0, '127.0.0.1');
    const origin = await downstream.getUrl();
    const contexts = ['slow', 'fast', 'broken'].map((id) => ({
      id,
      traceId: randomBytes(16).toString('hex'),
    }));
    await Promise.all(
      contexts.map(async ({ id, traceId }) => {
        const response = await fetch(`${origin}/proxy/${id}`, {
          headers: { traceparent: `00-${traceId}-${randomBytes(8).toString('hex')}-01` },
        });
        assert.equal(response.status, id === 'broken' ? 500 : 200);
        assert.equal(response.headers.get('traceparent').split('-')[1], traceId);
        await response.body.cancel();
      }),
    );
    for (const { id, traceId } of contexts) {
      const body = await readTrace(traceId, (value) => traceSpans(value).length >= 3);
      const spans = traceSpans(body);
      assert.equal(spans.length, 3);
      assert.deepEqual(new Set(spans.map((span) => span.service)), new Set(['bff', 'booking']));
      assert.equal(spans.filter((span) => span.name === 'http.client').length, 1);
      assert.ok(!JSON.stringify(body).includes('private'));
      if (id === 'broken')
        assert.ok(
          spans.some(
            (span) => span.status?.code === 'STATUS_CODE_ERROR' || span.status?.code === 2,
          ),
        );
    }
  } finally {
    await downstream?.close();
    await upstream?.close();
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
