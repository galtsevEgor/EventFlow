export type TelemetryConfig = {
  service: string;
  enabled: boolean;
  endpoint: string;
  sampleRatio: number;
  internalOrigins: string[];
  metricsEndpoint: string;
  environment: string;
  version: string;
};

export function telemetryConfig(
  service: string,
  env: NodeJS.ProcessEnv = process.env,
): TelemetryConfig {
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(service)) throw new Error('Invalid telemetry service');
  const enabled = env['EVENTFLOW_TELEMETRY_ENABLED'] === 'true';
  const sampleRatio = Number(env['EVENTFLOW_TRACE_SAMPLE_RATIO'] ?? '0.1');
  if (!Number.isFinite(sampleRatio) || sampleRatio < 0 || sampleRatio > 1)
    throw new Error('Trace sampling must be between zero and one');
  const endpoint = new URL(
    env['OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'] ?? 'http://127.0.0.1:14318/v1/traces',
  );
  if (
    !['http:', 'https:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error('Invalid trace export endpoint');
  const internalOrigins = [
    'BFF_URL',
    'CATALOG_URL',
    'BOOKING_URL',
    'PAYMENTS_URL',
    'TICKETS_URL',
  ].flatMap((key) => (env[key] ? [new URL(env[key]).origin] : []));
  const metricsEndpoint = new URL(
    env['OTEL_EXPORTER_OTLP_METRICS_ENDPOINT'] ??
      endpoint.href.replace(/\/v1\/traces$/, '/v1/metrics'),
  );
  if (
    !['http:', 'https:'].includes(metricsEndpoint.protocol) ||
    metricsEndpoint.username ||
    metricsEndpoint.password ||
    metricsEndpoint.search ||
    metricsEndpoint.hash
  )
    throw new Error('Invalid metrics export endpoint');
  const environment = env['EVENTFLOW_ENVIRONMENT'] ?? 'local';
  if (!['local', 'test', 'staging', 'demo', 'recovery'].includes(environment))
    throw new Error('Invalid telemetry environment');
  const build = env['EVENTFLOW_BUILD_ID'] ?? '';
  const version = /^[a-f0-9]{40}$/.test(build) ? build : 'dev';
  return {
    service,
    enabled,
    endpoint: endpoint.href,
    sampleRatio,
    internalOrigins,
    metricsEndpoint: metricsEndpoint.href,
    environment,
    version,
  };
}
