import test from 'node:test';
import assert from 'node:assert/strict';
import { analyticsFixture, fact } from '../helpers/analytics.mjs';
import { AnalyticsProjection } from '../../services/analytics/dist/projection.js';
import { AnalyticsMetrics } from '../../services/analytics/dist/metrics.js';
test('analytics exposes projection backlog and failure without tenant or session labels', async () => {
  const f = await analyticsFixture();
  try {
    const p = new AnalyticsProjection(f.journal, f.engine),
      metrics = new AnalyticsMetrics(p);
    await p.sync();
    await f.journal.append([fact()]);
    const points = await metrics.collect();
    assert.equal(points.find((p) => p.name === 'eventflow_analytics_pending').value, 1);
    assert.equal(points.find((p) => p.name === 'eventflow_analytics_ready').value, 1);
    assert.ok(points.every((p) => !JSON.stringify(p.attributes ?? {}).includes('organizationId')));
    const command = f.engine.command.bind(f.engine);
    f.engine.command = async () => {
      throw new Error('offline');
    };
    assert.equal(
      (await metrics.collect()).find((p) => p.name === 'eventflow_analytics_ready').value,
      0,
    );
    f.engine.command = command;
  } finally {
    await f.close();
  }
});
