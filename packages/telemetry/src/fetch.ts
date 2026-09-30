import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { currentTelemetry, currentTraceparent } from './tracing';

let installed = false;
export function instrumentFetch() {
  if (installed) return;
  installed = true;
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const telemetry = currentTelemetry();
    if (!telemetry?.config.enabled) return original(input, init);
    let url: URL;
    try {
      url = new URL(input instanceof Request ? input.url : String(input));
    } catch {
      return original(input, init);
    }
    if (!telemetry.config.internalOrigins.includes(url.origin)) return original(input, init);
    return telemetry.run(
      'http.client',
      async (span) => {
        const headers = new Headers(
          init?.headers ?? (input instanceof Request ? input.headers : undefined),
        );
        const parent = currentTraceparent();
        if (parent) headers.set('traceparent', parent);
        // Only W3C trace IDs are propagated. No arbitrary baggage crosses the service boundary.
        headers.delete('baggage');
        headers.delete('tracestate');
        const response = await original(input, { ...init, headers });
        span.setAttribute('http.response.status_code', response.status);
        if (response.status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
        return response;
      },
      {
        kind: SpanKind.CLIENT,
        attributes: {
          'http.request.method': init?.method ?? (input instanceof Request ? input.method : 'GET'),
          'server.address': url.hostname,
        },
      },
    );
  };
}
