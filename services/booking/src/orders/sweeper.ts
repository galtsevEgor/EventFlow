import { Logger } from '@nestjs/common';
import { Database } from '../database';
import { OrderLifecycle } from './lifecycle';

export class OrderSweeper {
  private stopped = true;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private readonly logger = new Logger(OrderSweeper.name);
  constructor(
    private readonly db: Database,
    private readonly lifecycle: OrderLifecycle,
  ) {}
  async sweep() {
    const candidates = await this.db.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Order" WHERE state = 'HELD' AND "expiresAt" <= clock_timestamp()
      ORDER BY "expiresAt", id LIMIT 50
    `;
    for (const order of candidates) await this.lifecycle.expire(order.id);
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule();
  }
  private schedule() {
    this.timer = setTimeout(() => {
      this.running = this.sweep()
        .catch(() => this.logger.warn('Order expiry failed; next batch will retry.'))
        .finally(() => {
          if (!this.stopped) this.schedule();
        });
    }, 5000);
    this.timer.unref();
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }
  onModuleInit() {
    this.start();
  }
  onModuleDestroy() {
    return this.stop();
  }
}
