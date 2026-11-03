import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { pythonPaths } from '../../scripts/recommendations.mjs';
import { metricValue, metricQuery } from '../helpers/metrics.mjs';

test(
  'Python API exports real Prometheus signals without caller identifiers or query text',
  { timeout: 60000 },
  async () => {
    const socket = createServer();
    await new Promise((done) => socket.listen(0, '127.0.0.1', done));
    const port = socket.address().port;
    await new Promise((done) => socket.close(done));
    const paths = pythonPaths(process.cwd()),
      build = randomBytes(20).toString('hex');
    const child = spawn(paths.python, ['-m', 'eventflow_recommendations.main'], {
      cwd: paths.service,
      env: {
        ...paths.variables,
        PORT: String(port),
        EVENTFLOW_TELEMETRY_ENABLED: 'true',
        EVENTFLOW_ENVIRONMENT: 'test',
        EVENTFLOW_BUILD_ID: build,
        EVENTFLOW_TRACE_SAMPLE_RATIO: '0',
      },
      stdio: 'ignore',
      windowsHide: true,
    });
    const closed = new Promise((done) => child.once('close', done));
    try {
      const origin = 'http://127.0.0.1:' + port;
      let ready = false;
      for (let i = 0; i < 60; i++) {
        assert.equal(child.exitCode, null, 'Python API exited before liveness');
        try {
          const response = await fetch(origin + '/health/live');
          ready = response.ok;
          await response.body.cancel();
        } catch {
          /* Starting. */
        }
        if (ready) break;
        await delay(200);
      }
      assert.ok(ready, 'Python API did not become live');
      const response = await fetch(
        origin + '/api/v1/recommendations/interests?query=private-query',
        { headers: { authorization: 'Bearer private-token' } },
      );
      assert.equal(response.status, 200);
      await response.body.cancel();
      const labels =
        'service_name="recommendations",service_version="' + build + '",component="api"';
      assert.ok(
        await metricValue(
          'eventflow_recommendations_requests_total{' +
            labels +
            ',operation="recommendationInterests"}',
        ),
      );
      const rows = await metricQuery(
        'eventflow_recommendations_request_duration_seconds_count{' + labels + '}',
      );
      assert.ok(rows.length);
      const serialized = JSON.stringify(rows);
      for (const value of [
        'private-query',
        'private-token',
        'authorization',
        'email',
        'actor',
        'eventId',
      ])
        assert.ok(!serialized.includes(value));
    } finally {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      try {
        await closed;
      } finally {
        clearTimeout(timer);
      }
    }
  },
);
