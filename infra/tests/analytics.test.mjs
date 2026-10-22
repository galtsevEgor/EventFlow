import test from 'node:test';
import assert from 'node:assert/strict';
import { ClickHouse } from '../../services/analytics/dist/clickhouse.js';
test('local ClickHouse requires credentials and uses the pinned supported LTS release', async () => {
  const url = new URL(process.env.CLICKHOUSE_URL);
  const denied = await fetch(url, { method: 'POST', body: 'SELECT 1' });
  assert.equal(denied.status, 401);
  const engine = new ClickHouse(process.env);
  assert.match(await engine.command('SELECT version()'), /^26\.8\.36\.3\s*$/);
});
