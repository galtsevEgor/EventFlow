import { offlineManifestSchema, type OfflineBundle } from '@eventflow/event-contracts';
import { type GateContext } from './crypto';

const SCANNER_WORKER_REPLY_TIMEOUT_MS = 15_000;

export class ScannerWorker {
  private readonly worker = new Worker(new URL('./scanner.worker.ts', import.meta.url), {
    type: 'module',
  });
  private sequence = 0;
  private closed = false;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor() {
    this.worker.addEventListener(
      'message',
      (event: MessageEvent<{ id: number; value?: unknown; error?: string }>) => {
        const task = this.pending.get(event.data.id);
        if (!task) return;
        clearTimeout(task.timer);
        this.pending.delete(event.data.id);
        if (event.data.error) task.reject(new Error(event.data.error));
        else task.resolve(event.data.value);
      },
    );
    this.worker.addEventListener('error', () => this.close());
  }
  private request(data: Record<string, unknown>, transfer: Transferable[] = []) {
    if (this.closed)
      return Promise.reject(new Error('Проверка остановлена. Откройте сканер заново.'));
    const id = ++this.sequence;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Проверка не ответила. Откройте сканер заново.'));
      }, SCANNER_WORKER_REPLY_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.worker.postMessage({ id, ...data }, transfer);
      } catch {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error('Worker недоступен.'));
      }
    });
  }
  async initialize(
    bundle: OfflineBundle,
    keyId: string,
    publicKey: CryptoKey,
    context: GateContext,
  ) {
    return offlineManifestSchema.parse(
      await this.request({ type: 'INIT', bundle, keyId, publicKey, context }),
    );
  }
  async check(credential: string, now: number) {
    await this.request({ type: 'CHECK', credential, now });
  }
  async frame(frame: ImageData) {
    const pixels = new Uint8ClampedArray(frame.data).buffer;
    const value = await this.request(
      { type: 'FRAME', pixels, width: frame.width, height: frame.height },
      [pixels],
    );
    return typeof value === 'string' ? value : null;
  }
  close() {
    this.closed = true;
    this.worker.terminate();
    for (const task of this.pending.values()) {
      clearTimeout(task.timer);
      task.reject(new Error('Проверка остановлена.'));
    }
    this.pending.clear();
  }
}
