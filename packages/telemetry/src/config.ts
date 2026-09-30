export type TelemetryConfig = {
  service: string;
  enabled: boolean;
  endpoint: string;
  sampleRatio: number;
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
  return { service, enabled, endpoint: endpoint.href, sampleRatio };
}
