import assert from 'node:assert/strict';
import test from 'node:test';
import { composeOutput, environment } from '../../scripts/release/local.mjs';

test('release Compose resolves telemetry on/off without publishing additional application ports', () => {
  const target = environment('staging');
  const render = (enabled) =>
    JSON.parse(
      composeOutput(
        { ...target, env: { ...target.env, EVENTFLOW_TELEMETRY_ENABLED: String(enabled) } },
        ['config', '--format', 'json'],
      ),
    );
  const disabled = render(false),
    enabled = render(true);
  assert.deepEqual(Object.keys(disabled.services.app.networks), ['default']);
  assert.deepEqual(Object.keys(enabled.services.app.networks).sort(), ['default', 'observability']);
  assert.equal(enabled.networks.observability.external, true);
  assert.equal(enabled.networks.observability.name, 'eventflow-observability_default');
  assert.equal(
    enabled.services.app.environment.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
    'http://collector:4318/v1/traces',
  );
  assert.equal(
    enabled.services.app.environment.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
    'http://collector:4318/v1/metrics',
  );
  assert.equal(enabled.services.app.environment.EVENTFLOW_ENVIRONMENT, 'staging');
  assert.equal(enabled.services.app.environment.EVENTFLOW_TELEMETRY_ENABLED, 'true');
  assert.deepEqual(enabled.services.app.ports, disabled.services.app.ports);
  assert.equal(environment('recovery').env.EVENTFLOW_TELEMETRY_ENABLED, 'false');
});
