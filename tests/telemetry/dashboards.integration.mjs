import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { eventually } from '../helpers/eventually.mjs';
import { metricQuery } from '../helpers/metrics.mjs';

test('provisioned Grafana dashboards retain their queries and Prometheus loads every alert', async () => {
  for (const uid of ['eventflow-overview', 'eventflow-delivery']) {
    const source = JSON.parse(readFileSync(`infra/observability/dashboards/${uid}.json`, 'utf8'));
    const body = await eventually(
      async () => {
        const response = await fetch(`http://127.0.0.1:13000/api/dashboards/uid/${uid}`, {
          signal: AbortSignal.timeout(2000),
        });
        if (!response.ok) {
          await response.body.cancel();
          return undefined;
        }
        return response.json();
      },
      (value) =>
        value &&
        value.dashboard.panels.length === source.panels.length &&
        value.dashboard.panels.every((panel) =>
          panel.targets.every((target) =>
            source.panels.some((entry) => entry.targets.some((item) => item.expr === target.expr)),
          ),
        ),
      20000,
    );
    assert.equal(body.meta.provisioned, true);
    assert.equal(body.dashboard.editable, false);
    assert.equal(body.dashboard.panels.length, source.panels.length);
    for (const panel of body.dashboard.panels)
      for (const target of panel.targets) {
        assert.equal(target.datasource.uid, 'eventflow-prometheus');
        assert.ok(
          source.panels.some((entry) => entry.targets.some((item) => item.expr === target.expr)),
        );
        await metricQuery(target.expr.replaceAll('$environment', 'staging'));
      }
  }
  const response = await fetch('http://127.0.0.1:19090/api/v1/rules', {
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(response.status, 200);
  const rules = (await response.json()).data.groups.flatMap((group) => group.rules);
  assert.equal(rules.filter((rule) => rule.type === 'alerting').length, 9);
  assert.ok(
    rules.every((rule) => rule.health === 'ok'),
    'An alert expression failed evaluation',
  );
  assert.equal(rules.filter((rule) => rule.name === 'eventflow:service_expected').length, 6);
});
