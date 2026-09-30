import { resourceFromAttributes } from '@opentelemetry/resources';
import type { SpanExporter, ReadableSpan } from '@opentelemetry/sdk-trace';
import type { ExportResult } from '@opentelemetry/core';

const allowed = new Set([
  'http.request.method',
  'http.route',
  'http.response.status_code',
  'server.address',
  'eventflow.operation',
  'eventflow.outcome',
  'eventflow.consumer',
  'eventflow.event_type',
  'eventflow.attempt',
  'db.system.name',
]);
export function cleanSpan(span: ReadableSpan): ReadableSpan {
  return {
    kind: span.kind,
    spanContext: () => span.spanContext(),
    ...(span.parentSpanContext ? { parentSpanContext: span.parentSpanContext } : {}),
    startTime: span.startTime,
    endTime: span.endTime,
    duration: span.duration,
    ended: span.ended,
    droppedAttributesCount: span.droppedAttributesCount,
    droppedEventsCount: span.droppedEventsCount,
    droppedLinksCount: span.droppedLinksCount,
    name: /^[a-z][a-z0-9_.]{0,63}$/.test(span.name) ? span.name : 'server.operation',
    status: { code: span.status.code },
    attributes: Object.fromEntries(
      Object.entries(span.attributes).filter(
        ([key, value]) =>
          allowed.has(key) &&
          ((typeof value === 'string' && value.length <= 128) ||
            typeof value === 'number' ||
            typeof value === 'boolean'),
      ),
    ),
    events: [],
    links: span.links.slice(0, 4).map(({ context }) => ({ context })),
    resource: resourceFromAttributes({
      'service.name': span.resource.attributes['service.name'] ?? 'unknown',
    }),
    instrumentationScope: { name: 'eventflow' },
  };
}
export class RedactingExporter implements SpanExporter {
  constructor(private readonly exporter: SpanExporter) {}
  export(spans: ReadableSpan[], callback: (result: ExportResult) => void) {
    this.exporter.export(spans.map(cleanSpan), callback);
  }
  shutdown() {
    return this.exporter.shutdown();
  }
}
