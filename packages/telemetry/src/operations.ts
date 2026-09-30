import { context, trace, ROOT_CONTEXT, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { currentTelemetry, traceContext, type Telemetry } from './tracing';

export function traceFailure() {
  trace.getSpan(context.active())?.setStatus({ code: SpanStatusCode.ERROR });
}
export function linkTrace(parent: unknown) {
  const linked = trace.getSpanContext(traceContext(parent));
  if (linked) trace.getSpan(context.active())?.addLink({ context: linked });
}
export function operation<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const telemetry = currentTelemetry();
  return telemetry?.config.enabled ? telemetry.run(name, fn) : fn();
}
export function observedJob<T>(
  telemetry: Telemetry | undefined,
  name: string,
  fn: () => Promise<T>,
  options: { parent?: unknown; attempt?: number; kind?: SpanKind } = {},
): Promise<T> {
  if (!telemetry?.config.enabled) return fn();
  const parent = traceContext(options.parent);
  const linked = trace.getSpanContext(parent);
  const caller = trace.getSpanContext(context.active());
  const attempt = options.attempt ?? 0;
  const links = [
    ...(attempt && linked ? [{ context: linked }] : []),
    ...(caller && caller.traceId !== linked?.traceId ? [{ context: caller }] : []),
  ];
  return telemetry.run(
    name,
    fn,
    {
      kind: options.kind ?? SpanKind.INTERNAL,
      attributes: { 'eventflow.attempt': attempt },
      links,
    },
    attempt ? ROOT_CONTEXT : parent,
  );
}
