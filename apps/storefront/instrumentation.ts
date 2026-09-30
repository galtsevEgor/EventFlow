export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.EVENTFLOW_TELEMETRY_ENABLED === 'true') {
    const { registerGlobalTelemetry, instrumentFetch } = await import('@eventflow/telemetry');
    registerGlobalTelemetry('storefront');
    instrumentFetch();
  }
}
