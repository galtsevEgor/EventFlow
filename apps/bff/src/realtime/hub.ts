import { randomUUID } from 'node:crypto';
import { ApiError } from '@eventflow/service-runtime';
import type { RealtimeHint } from '@eventflow/event-contracts';
import type { Request, Response } from 'express';
import type { AuthConfig } from '../auth/config';
import { RealtimeBus } from './bus';
import { UpdatesAccess } from './access';
import { UpdatesConnection, type StreamMetrics } from './connection';
import { StreamQuota } from './quota';

export class RealtimeHub {
  readonly metrics: StreamMetrics = {
    opened: 0,
    closed: 0,
    changed: 0,
    heartbeats: 0,
    coalesced: 0,
    blocked: 0,
    slow: 0,
    authFailed: 0,
  };
  private readonly connections = new Set<UpdatesConnection>();
  private opening = 0;
  private report: NodeJS.Timeout | undefined;
  constructor(
    private readonly config: AuthConfig,
    private readonly bus: RealtimeBus,
    private readonly access: UpdatesAccess,
    private readonly quota: StreamQuota,
  ) {}
  snapshot() {
    return {
      ...this.metrics,
      active: this.connections.size,
      opening: this.opening,
      ready: this.bus.ready,
    };
  }
  onModuleInit() {
    this.report = setInterval(() => {
      if (this.metrics.opened)
        console.log(JSON.stringify({ kind: 'realtime_metrics', ...this.snapshot() }));
    }, 30000);
    this.report.unref();
  }
  async open(request: Request, response: Response, target: RealtimeHint) {
    if (!this.bus.ready)
      throw new ApiError(503, 'UPDATES_UNAVAILABLE', 'Автообновление временно недоступно.');
    if (this.connections.size + this.opening >= this.config.REALTIME_MAX_CONNECTIONS) {
      this.metrics.blocked++;
      throw new ApiError(429, 'UPDATES_LIMIT', 'Достигнут лимит подключений.');
    }
    this.opening++;
    let acquired = false;
    let principal = '';
    const id = randomUUID();
    try {
      const access = await this.access.open(request, target);
      principal = access.principal;
      acquired = await this.quota.acquire(principal, id);
      if (!acquired) {
        this.metrics.blocked++;
        throw new ApiError(
          429,
          'UPDATES_LIMIT',
          'Закройте лишние вкладки и повторите подключение.',
        );
      }
      if (response.destroyed) {
        await this.quota.release(principal, id);
        acquired = false;
        return;
      }
      if (!this.bus.ready)
        throw new ApiError(503, 'UPDATES_UNAVAILABLE', 'Автообновление временно недоступно.');
      const connection = new UpdatesConnection(
        response,
        () => this.bus.ready,
        async () => {
          await access.check();
          return this.quota.renew(principal, id);
        },
        () => {
          detach();
          this.connections.delete(connection);
          void this.quota.release(principal, id);
        },
        this.metrics,
      );
      const detach = this.bus.listen(target, connection.pulse, connection.close);
      this.connections.add(connection);
      this.metrics.opened++;
      connection.start(this.config.REALTIME_HEARTBEAT_MS);
      acquired = false;
    } finally {
      this.opening--;
      if (acquired) await this.quota.release(principal, id);
    }
  }
  onModuleDestroy() {
    clearInterval(this.report);
    for (const connection of [...this.connections]) connection.close();
  }
}
