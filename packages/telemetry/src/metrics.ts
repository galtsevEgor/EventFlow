import { trace, ROOT_CONTEXT, SpanKind, type Context, type Observable } from '@opentelemetry/api';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  createAllowListAttributesProcessor,
  type PushMetricExporter,
} from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import type { Resource } from '@opentelemetry/resources';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace';
import {
  metricMethod,
  metricRoute,
  type SnapshotName,
  type Measurement,
} from './metric-definitions';

const boundaries = [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const consumers = new Set([
  'booking',
  'catalog',
  'payments',
  'tickets',
  'statistics',
  'realtime',
  'booking-refunds',
  'payment-refunds',
  'ticket-refunds',
]);

export class Metrics {
  readonly provider: MeterProvider;
  private readonly meter;
  private readonly requests;
  private readonly httpDuration;
  private readonly queries;
  private readonly queryDuration;
  private readonly messages;
  private readonly mail;
  private readonly collectionErrors;
  private readonly removers = new Set<() => void>();
  private closing = false;

  constructor(resource: Resource, endpoint: string, exporter?: PushMetricExporter) {
    this.provider = new MeterProvider({
      resource,
      views: [
        {
          instrumentName: '*',
          aggregationCardinalityLimit: 256,
          attributesProcessors: [
            createAllowListAttributesProcessor([
              'method',
              'route',
              'status',
              'operation',
              'outcome',
              'consumer',
              'state',
              'component',
              'kind',
            ]),
          ],
        },
      ],
      readers: [
        new PeriodicExportingMetricReader({
          exporter:
            exporter ??
            new OTLPMetricExporter({
              url: endpoint,
              timeoutMillis: 1000,
              concurrencyLimit: 1,
              headers: {},
              temporalityPreference: 1,
            }),
          exportIntervalMillis: 5000,
          exportTimeoutMillis: 1500,
          maxExportBatchSize: 512,
          cardinalityLimits: { default: 256 },
        }),
      ],
    });
    this.meter = this.provider.getMeter('eventflow');
    this.requests = this.meter.createCounter('eventflow_http_requests');
    this.httpDuration = this.meter.createHistogram('eventflow_http_request_duration', {
      unit: 's',
      advice: { explicitBucketBoundaries: boundaries },
    });
    this.queries = this.meter.createCounter('eventflow_db_queries');
    this.queryDuration = this.meter.createHistogram('eventflow_db_query_duration', {
      unit: 's',
      advice: { explicitBucketBoundaries: boundaries },
    });
    this.messages = this.meter.createCounter('eventflow_messages');
    this.mail = this.meter.createCounter('eventflow_mail_deliveries');
    this.collectionErrors = this.meter.createCounter('eventflow_metric_collection_errors');
    this.meter
      .createObservableGauge('eventflow_service_up')
      .addCallback((result) => result.observe(this.closing ? 0 : 1));
    this.meter
      .createObservableGauge('eventflow_process_memory', { unit: 'By' })
      .addCallback((result) => result.observe(process.memoryUsage().rss));
    this.meter
      .createObservableCounter('eventflow_process_cpu', { unit: 's' })
      .addCallback((result) => {
        const cpu = process.cpuUsage();
        result.observe((cpu.user + cpu.system) / 1e6);
      });
  }
  http(method: string, route: unknown, status: number, seconds: number, ctx?: Context) {
    const attributes = {
      method: metricMethod(method),
      route: metricRoute(route),
      status: String(status),
    };
    this.requests.add(1, attributes, ctx);
    this.httpDuration.record(Math.max(0, seconds), attributes, ctx);
  }
  query(milliseconds: number) {
    this.queries.add(1);
    this.queryDuration.record(Math.max(0, milliseconds) / 1000);
  }
  message(
    operation: 'send' | 'consume' | 'retry' | 'dead',
    outcome: 'ok' | 'error',
    consumer: string,
  ) {
    this.messages.add(1, {
      operation,
      outcome,
      consumer: consumers.has(consumer) ? consumer : 'other',
    });
  }
  delivery(outcome: 'sent' | 'skipped' | 'retry' | 'dead' | 'queue_error') {
    this.mail.add(1, { outcome });
  }
  supply(names: SnapshotName[], collect: () => Promise<Measurement[]> | Measurement[]) {
    const instruments = new Map<SnapshotName, Observable>(
      names.map((name) => [
        name,
        name === 'eventflow_sse_events'
          ? this.meter.createObservableCounter(name)
          : this.meter.createObservableGauge(name),
      ]),
    );
    let busy = false;
    const callback: Parameters<typeof this.meter.addBatchObservableCallback>[0] = async (
      result,
    ) => {
      if (busy || this.closing) return;
      busy = true;
      try {
        for (const point of await collect()) {
          const instrument = instruments.get(point.name);
          if (instrument && Number.isFinite(point.value))
            result.observe(instrument, point.value, point.attributes);
        }
      } catch {
        this.collectionErrors.add(1);
      } finally {
        busy = false;
      }
    };
    this.meter.addBatchObservableCallback(callback, [...instruments.values()]);
    const remove = () => {
      this.meter.removeBatchObservableCallback(callback, [...instruments.values()]);
      this.removers.delete(remove);
    };
    this.removers.add(remove);
    return remove;
  }
  ssrProcessor(): SpanProcessor {
    return {
      onStart() {},
      onEnd: (span: ReadableSpan) => {
        if (span.kind !== SpanKind.SERVER) return;
        const attrs = span.attributes;
        this.http(
          String(attrs['http.request.method'] ?? attrs['http.method'] ?? 'GET'),
          attrs['http.route'] ?? attrs['next.route'],
          Number(
            attrs['http.response.status_code'] ??
              attrs['http.status_code'] ??
              (span.status.code === 2 ? 500 : 200),
          ),
          span.duration[0] + span.duration[1] / 1e9,
          trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext(span.spanContext())),
        );
      },
      forceFlush: async () => {},
      shutdown: async () => {},
    };
  }
  async flush() {
    await this.provider.forceFlush({ timeoutMillis: 2000 }).catch(() => {});
  }
  async shutdown() {
    this.closing = true;
    for (const remove of [...this.removers]) remove();
    await this.flush();
    await this.provider.shutdown({ timeoutMillis: 2000 }).catch(() => {});
  }
}
