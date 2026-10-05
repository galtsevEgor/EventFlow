import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { PushMetricExporter } from '@opentelemetry/sdk-metrics';
import {
  context,
  trace,
  propagation,
  ROOT_CONTEXT,
  INVALID_SPAN_CONTEXT,
  isSpanContextValid,
  SpanStatusCode,
  type Span,
  type SpanOptions,
  type Context,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  TracerProvider,
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  createAlwaysRecordSampler,
  type SpanExporter,
} from '@opentelemetry/sdk-trace';
import { telemetryConfig, type TelemetryConfig } from './config';
import { RedactingExporter } from './redaction';
import { Metrics } from './metrics';

const owner = new AsyncLocalStorage<Telemetry>();
const propagator = new W3CTraceContextPropagator();
const validParent = /^00-(?!0{32}-)[a-f0-9]{32}-(?!0{16}-)[a-f0-9]{16}-0[01]$/;
let contextReady = false;
let defaultTelemetry: Telemetry | undefined;

export function validTraceparent(parent: unknown): string | undefined {
  return typeof parent === 'string' && validParent.test(parent) ? parent : undefined;
}
export function traceContext(parent: unknown): Context {
  return validTraceparent(parent)
    ? propagator.extract(
        ROOT_CONTEXT,
        { traceparent: String(parent) },
        {
          keys: () => ['traceparent'],
          get: (carrier, key) => carrier[key as keyof typeof carrier],
        },
      )
    : ROOT_CONTEXT;
}
export function currentTraceparent() {
  const span = trace.getSpanContext(context.active());
  return span && isSpanContextValid(span)
    ? `00-${span.traceId}-${span.spanId}-${span.traceFlags & 1 ? '01' : '00'}`
    : undefined;
}
export function currentTelemetry() {
  return owner.getStore() ?? defaultTelemetry;
}
export function initializeTelemetry(service: string) {
  defaultTelemetry = new Telemetry(telemetryConfig(service));
  return defaultTelemetry;
}
export function registerGlobalTelemetry(service: string) {
  const telemetry = initializeTelemetry(service);
  if (telemetry.provider) {
    trace.setGlobalTracerProvider(telemetry.provider);
    propagation.setGlobalPropagator(propagator);
  }
  return telemetry;
}

export class Telemetry {
  readonly provider: TracerProvider | undefined;
  readonly metrics: Metrics | undefined;
  readonly instanceId = randomUUID();
  constructor(
    readonly config: TelemetryConfig,
    exporters: { traces?: SpanExporter; metrics?: PushMetricExporter | false } = {},
  ) {
    if (!config.enabled) return;
    if (!contextReady) {
      context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
      contextReady = true;
    }
    const resource = resourceFromAttributes({
      'service.name': config.service,
      'service.instance.id': this.instanceId,
      'deployment.environment.name': config.environment,
      'service.version': config.version,
    });
    if (exporters.metrics !== false)
      this.metrics = new Metrics(resource, config.metricsEndpoint, exporters.metrics);
    const sampler = new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(config.sampleRatio),
    });
    this.provider = new TracerProvider({
      resource,
      sampler:
        config.service === 'storefront' && this.metrics
          ? createAlwaysRecordSampler(sampler)
          : sampler,
      spanLimits: {
        attributeCountLimit: 16,
        attributeValueLengthLimit: 128,
        eventCountLimit: 0,
        linkCountLimit: 4,
      },
      spanProcessors: [
        new BatchSpanProcessor({
          exporter: new RedactingExporter(
            exporters.traces ??
              new OTLPTraceExporter({
                url: config.endpoint,
                timeoutMillis: 1000,
                concurrencyLimit: 1,
                headers: {},
              }),
          ),
          maxQueueSize: 1024,
          maxExportBatchSize: 64,
          scheduledDelayMillis: 500,
          exportTimeoutMillis: 1500,
        }),
        ...(config.service === 'storefront' && this.metrics ? [this.metrics.ssrProcessor()] : []),
      ],
    });
  }
  start(name: string, options: SpanOptions = {}, parent: Context = context.active()) {
    return (
      this.provider?.getTracer('eventflow').startSpan(name, options, parent) ??
      trace.wrapSpanContext(INVALID_SPAN_CONTEXT)
    );
  }
  within<T>(span: Span, fn: () => T): T {
    return owner.run(this, () => context.with(trace.setSpan(context.active(), span), fn));
  }
  async run<T>(
    name: string,
    fn: (span: Span) => Promise<T>,
    options: SpanOptions = {},
    parent: Context = context.active(),
  ): Promise<T> {
    const span = this.start(name, options, parent);
    try {
      return await this.within(span, () => fn(span));
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  }
  async flush() {
    await Promise.all([
      this.provider?.forceFlush({ timeoutMillis: 2000 }).catch(() => {}),
      this.metrics?.flush(),
    ]);
  }
  async shutdown() {
    await Promise.all([this.provider?.shutdown().catch(() => {}), this.metrics?.shutdown()]);
    if (defaultTelemetry === this) defaultTelemetry = undefined;
  }
}
