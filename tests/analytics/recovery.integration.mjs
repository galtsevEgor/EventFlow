import assert from 'node:assert/strict';
import test from 'node:test';
import { analyticsFixture, fact } from '../helpers/analytics.mjs';
import { AnalyticsProjection } from '../../services/analytics/dist/projection.js';
import { ClickHouse } from '../../services/analytics/dist/clickhouse.js';
import { Journal } from '../../services/analytics/dist/journal.js';
test('a lost writer connection cannot persist a checkpoint or keep its lock', async () => {
  const f = await analyticsFixture();
  try {
    await f.journal.lock(180020, async (client) => {
      const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await f.journal.pool.query('SELECT pg_terminate_backend($1)', [pid]);
      await assert.rejects(f.journal.save(client, '00000000-0000-4000-8000-000000000001', '100'));
    });
    assert.equal(await f.journal.checkpoint(), null);
    assert.equal(await f.journal.lock(180020, async () => true), true);
  } finally {
    await f.close();
  }
});
test('ClickHouse outage leaves accepted facts durable through service restart and later replay', async () => {
  const f = await analyticsFixture();
  try {
    const row = fact();
    await f.journal.append([row]);
    const down = new ClickHouse({ ...f.env, CLICKHOUSE_URL: 'http://127.0.0.1:1' });
    await assert.rejects(new AnalyticsProjection(f.journal, down).sync());
    const restarted = new Journal(f.env.ANALYTICS_DATABASE_URL);
    try {
      assert.equal((await restarted.rows('0')).length, 1);
      const p = new AnalyticsProjection(restarted, f.engine);
      await p.sync();
      assert.equal((await p.status()).pending, 0);
    } finally {
      await restarted.onModuleDestroy();
    }
  } finally {
    await f.close();
  }
});
test('lost atomic swap ACK and table replacement during export cannot skip journal facts', async () => {
  const f = await analyticsFixture();
  try {
    const p = new AnalyticsProjection(f.journal, f.engine);
    await f.journal.append([fact()]);
    await p.sync();
    const command = f.engine.command.bind(f.engine);
    let lose = true;
    f.engine.command = async (sql, params) => {
      const result = await command(sql, params);
      if (lose && sql.startsWith('EXCHANGE')) {
        lose = false;
        throw new Error('lost swap ACK');
      }
      return result;
    };
    await assert.rejects(p.rebuild());
    await assert.rejects(p.status());
    await p.sync();
    assert.equal((await p.status()).pending, 0);
    const insert = f.engine.insert.bind(f.engine);
    let replace = true;
    await f.journal.append([fact()]);
    f.engine.insert = async (...args) => {
      await insert(...args);
      if (replace) {
        replace = false;
        await command('DROP TABLE ' + f.engine.table() + ' SYNC');
        await f.engine.initialize();
      }
    };
    await p.sync();
    await assert.rejects(p.status());
    await p.sync();
    assert.equal(
      Number((await f.engine.rows('SELECT count() AS n FROM ' + f.engine.table() + ' FINAL'))[0].n),
      2,
    );
  } finally {
    await f.close();
  }
});
