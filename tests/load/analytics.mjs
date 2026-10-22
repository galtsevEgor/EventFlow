import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { analyticsFixture, fact } from '../helpers/analytics.mjs';
import { AnalyticsProjection } from '../../services/analytics/dist/projection.js';
import { AnalyticsReport } from '../../services/analytics/dist/report.js';
const smoke = process.argv.includes('--smoke'),
  sessions = smoke ? 500 : 25000;
const f = await analyticsFixture();
try {
  const p = new AnalyticsProjection(f.journal, f.engine),
    report = new AnalyticsReport(f.engine, p);
  const organizationId = randomUUID(),
    eventId = randomUUID(),
    rows = [];
  for (let i = 0; i < sessions; i++) {
    const sessionId = randomUUID(),
      orderId = randomUUID(),
      base = fact({ organizationId, eventId, sessionId });
    rows.push({ ...base, key: randomUUID(), kind: 'impression' });
    if (i % 2 === 0)
      rows.push({
        ...base,
        key: randomUUID(),
        kind: 'event_view',
        occurredAt: '2026-11-09T10:01:00.000Z',
      });
    if (i % 4 === 0)
      rows.push(
        {
          ...base,
          key: randomUUID(),
          kind: 'held',
          orderId,
          source: 'booking',
          occurredAt: '2026-11-09T10:02:00.000Z',
        },
        {
          ...base,
          key: randomUUID(),
          kind: 'confirmed',
          orderId,
          source: 'booking',
          occurredAt: '2026-11-09T10:03:00.000Z',
        },
      );
  }
  const start = performance.now();
  for (let i = 0; i < rows.length; i += 1000) await f.journal.append(rows.slice(i, i + 1000));
  const journalMs = performance.now() - start,
    projectStart = performance.now();
  await p.sync();
  const projectionMs = performance.now() - projectStart,
    times = [];
  for (let i = 0; i < (smoke ? 3 : 15); i++) {
    const started = performance.now(),
      result = await report.read(organizationId, { from: '2026-11-09', to: '2026-11-09' });
    times.push(performance.now() - started);
    assert.equal(result.current.impressions, sessions);
    assert.equal(result.current.confirmed, Math.ceil(sessions / 4));
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.ceil(times.length * 0.95) - 1];
  let resources = null;
  try {
    resources = JSON.parse(
      execFileSync(
        'docker',
        ['inspect', '--format', '{{json .HostConfig}}', 'eventflow-local-clickhouse-1'],
        { encoding: 'utf8', windowsHide: true },
      ),
    );
  } catch {
    /* CI may use an alternate Compose project name. */
  }
  const result = {
    mode: smoke ? 'smoke' : 'local',
    sessions,
    facts: rows.length,
    journalMs,
    projectionMs,
    reportP95Ms: p95,
    querySamples: times,
    resources: resources ? { nanoCpus: resources.NanoCpus, memoryBytes: resources.Memory } : null,
  };
  mkdirSync('work/e18', { recursive: true });
  writeFileSync(
    'work/e18/analytics-load' + (smoke ? '-smoke' : '') + '.json',
    JSON.stringify(result, null, 2) + '\n',
  );
  console.log(JSON.stringify(result));
  assert.ok(p95 < 5000, 'OLAP report p95 exceeded 5s on the fixed local budget');
} finally {
  await f.close();
}
