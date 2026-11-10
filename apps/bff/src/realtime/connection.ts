import type { Response } from 'express';

const STREAM_MIN_LIFETIME_MS = 120_000;
const STREAM_LIFETIME_JITTER_MS = 15_000;
const STREAM_UPDATE_DEBOUNCE_MS = 200;

export type StreamMetrics = {
  opened: number;
  closed: number;
  changed: number;
  heartbeats: number;
  coalesced: number;
  blocked: number;
  slow: number;
  authFailed: number;
};
export class UpdatesConnection {
  private closed = false;
  private busy = false;
  private dirty = false;
  private debounce: NodeJS.Timeout | undefined;
  private heartbeat?: NodeJS.Timeout;
  private lifetime?: NodeJS.Timeout;
  constructor(
    private readonly response: Response,
    private readonly healthy: () => boolean,
    private readonly check: () => Promise<boolean>,
    private readonly cleanup: () => void,
    private readonly metrics: StreamMetrics,
  ) {}
  start(heartbeatMs: number) {
    this.response.once('close', this.close);
    this.response.status(200).set({
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      'x-accel-buffering': 'no',
      'cross-origin-resource-policy': 'same-origin',
    });
    this.response.flushHeaders();
    this.send('ready');
    if (this.closed) return;
    this.heartbeat = setInterval(() => void this.verify(), heartbeatMs);
    const lifetime = STREAM_MIN_LIFETIME_MS + Math.floor(Math.random() * STREAM_LIFETIME_JITTER_MS);
    this.lifetime = setTimeout(this.close, lifetime);
  }
  readonly pulse = () => {
    if (this.closed) return;
    if (this.dirty) this.metrics.coalesced++;
    this.dirty = true;
    if (!this.debounce)
      this.debounce = setTimeout(() => {
        this.debounce = undefined;
        void this.verify();
      }, STREAM_UPDATE_DEBOUNCE_MS);
  };
  private async verify() {
    if (this.closed || this.busy) return;
    if (!this.healthy()) return this.close();
    this.busy = true;
    const changed = this.dirty;
    this.dirty = false;
    try {
      if (!(await this.check())) return this.close();
      if (!this.closed) this.send(changed ? 'changed' : 'heartbeat');
    } catch {
      this.metrics.authFailed++;
      this.close();
    } finally {
      this.busy = false;
      if (this.dirty) this.pulse();
    }
  }
  private send(kind: 'ready' | 'changed' | 'heartbeat') {
    if (this.closed || this.response.destroyed) return this.close();
    if (
      this.response.writableLength > 16384 ||
      !this.response.write(`event: update\ndata: ${JSON.stringify({ kind })}\n\n`)
    ) {
      this.metrics.slow++;
      this.close();
      return;
    }
    if (kind === 'changed') this.metrics.changed++;
    if (kind === 'heartbeat') this.metrics.heartbeats++;
  }
  readonly close = () => {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.debounce);
    clearInterval(this.heartbeat);
    clearTimeout(this.lifetime);
    this.cleanup();
    this.metrics.closed++;
    this.response.destroy();
  };
}
