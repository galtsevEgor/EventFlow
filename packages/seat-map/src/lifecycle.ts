/** Dispose a resource even when its asynchronous creation finishes after unmount. */
export function attachAsync<T extends { destroy: () => void }>(
  create: (signal: AbortSignal) => Promise<T>,
  ready: (value: T) => void,
  failed: (error: unknown) => void,
): () => void {
  const abort = new AbortController();
  let resource: T | undefined;
  void create(abort.signal).then(
    (value) => {
      if (abort.signal.aborted) value.destroy();
      else {
        resource = value;
        ready(value);
      }
    },
    (error) => {
      if (!abort.signal.aborted) failed(error);
    },
  );
  return () => {
    abort.abort();
    resource?.destroy();
    resource = undefined;
  };
}
