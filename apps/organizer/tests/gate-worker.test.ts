import { afterEach, expect, it, vi } from 'vitest';
import { ScannerWorker } from '../src/gate/worker-client';

class TestWorker extends EventTarget {
  static current: TestWorker;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    super();
    TestWorker.current = this;
  }
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('rejects in-flight and subsequent requests when the scanner worker fails', async () => {
  vi.stubGlobal('Worker', TestWorker);
  const client = new ScannerWorker();
  const checking = expect(client.check('a'.repeat(32), Date.now())).rejects.toThrow('остановлена');
  TestWorker.current.dispatchEvent(new Event('error'));
  await checking;
  await expect(client.check('a'.repeat(32), Date.now())).rejects.toThrow('остановлена');
  expect(TestWorker.current.postMessage).toHaveBeenCalledTimes(1);
  expect(TestWorker.current.terminate).toHaveBeenCalledOnce();
});
it('times out an unresponsive worker without leaving a pending UI operation', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('Worker', TestWorker);
  const client = new ScannerWorker();
  const checking = expect(client.check('a'.repeat(32), Date.now())).rejects.toThrow('не ответила');
  await vi.advanceTimersByTimeAsync(15000);
  await checking;
  client.close();
});
