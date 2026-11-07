import { expect, it, vi } from 'vitest';
import { attachAsync } from '../src/lifecycle.js';

const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

it('destroys a renderer that finishes after unmount, without delivering readiness', async () => {
  const pending = deferred<{ destroy: () => void }>(),
    destroy = vi.fn(),
    ready = vi.fn(),
    failed = vi.fn();
  let signal: AbortSignal | undefined;
  const cleanup = attachAsync(
    (value) => {
      signal = value;
      return pending.promise;
    },
    ready,
    failed,
  );
  cleanup();
  expect(signal?.aborted).toBe(true);
  pending.resolve({ destroy });
  await pending.promise;
  expect(destroy).toHaveBeenCalledOnce();
  expect(ready).not.toHaveBeenCalled();
  expect(failed).not.toHaveBeenCalled();
});

it('cleans an initialized renderer once and ignores late init failures after unmount', async () => {
  const destroy = vi.fn(),
    ready = vi.fn(),
    failed = vi.fn();
  const cleanup = attachAsync(async () => ({ destroy }), ready, failed);
  await Promise.resolve();
  expect(ready).toHaveBeenCalledOnce();
  cleanup();
  cleanup();
  expect(destroy).toHaveBeenCalledOnce();
  const pending = deferred<{ destroy: () => void }>();
  const cancel = attachAsync(() => pending.promise, ready, failed);
  cancel();
  pending.reject(new Error('late'));
  await pending.promise.catch(() => {});
  expect(failed).not.toHaveBeenCalled();
});

it('delivers actual initialization failures for native list fallback', async () => {
  const failed = vi.fn(),
    error = new Error('No WebGL');
  attachAsync(
    async () => {
      throw error;
    },
    vi.fn(),
    failed,
  );
  await Promise.resolve();
  expect(failed).toHaveBeenCalledWith(error);
});
