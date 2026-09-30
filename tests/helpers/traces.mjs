import { eventually } from './eventually.mjs';

export function traceHex(value) {
  return /^[a-f0-9]{32}$/i.test(value)
    ? value.toLowerCase()
    : Buffer.from(value, 'base64').toString('hex');
}

export async function readTrace(id, accept = () => true) {
  return eventually(
    async () => {
      const response = await fetch(`http://127.0.0.1:13200/api/traces/${id}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) {
        await response.body.cancel();
        return null;
      }
      return response.json();
    },
    (value) => Boolean(value && accept(value)),
    20000,
  );
}
export function traceSpans(body) {
  return (body.batches ?? body.resourceSpans ?? []).flatMap((batch) => {
    const service = batch.resource?.attributes?.find(
      (attribute) => attribute.key === 'service.name',
    )?.value?.stringValue;
    return (batch.scopeSpans ?? batch.instrumentationLibrarySpans ?? []).flatMap((scope) =>
      scope.spans.map((span) => ({ ...span, service })),
    );
  });
}
