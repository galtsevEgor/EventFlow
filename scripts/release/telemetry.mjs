const baseFiles = ['infra/compose/compose.yaml', 'infra/release/compose.yaml'];
const keys = [
  'EVENTFLOW_TELEMETRY_ENABLED',
  'EVENTFLOW_ENVIRONMENT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
];

export function composeFiles(env) {
  return env.EVENTFLOW_TELEMETRY_ENABLED === 'true'
    ? [...baseFiles, 'infra/release/observability.yaml']
    : baseFiles;
}

export function telemetrySettings(source, name, enabled) {
  if (!['staging', 'demo'].includes(name) || typeof enabled !== 'boolean')
    throw new Error('Choose staging or demo and on/off');
  const retained = source
    .split(/\r?\n/)
    .filter((line) => !keys.some((key) => line.startsWith(key + '=')))
    .join('\n')
    .trimEnd();
  return (
    retained +
    '\n' +
    [
      `EVENTFLOW_TELEMETRY_ENABLED=${enabled}`,
      `EVENTFLOW_ENVIRONMENT=${name}`,
      'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://collector:4318/v1/traces',
      'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT=http://collector:4318/v1/metrics',
    ].join('\n') +
    '\n'
  );
}
