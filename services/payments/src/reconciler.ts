import type { ProcessAttempt } from './attempts/process';
import type { ProcessRefund } from './refunds/process';
import type { ProcessWebhooks } from './webhooks/process';

export class Reconciler {
  private stopped = true;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> = Promise.resolve();
  constructor(
    private readonly attempts: ProcessAttempt,
    private readonly refunds: ProcessRefund,
    private readonly webhooks: ProcessWebhooks,
  ) {}
  onModuleInit() {
    this.start();
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }
  private schedule(delay: number) {
    if (!this.stopped)
      this.timer = setTimeout(() => {
        this.running = this.tick();
      }, delay);
  }
  private async tick() {
    try {
      await this.webhooks.run();
      for (let i = 0; i < 10 && !this.stopped; i++) {
        if (!(await this.refunds.run())) break;
      }
      for (let i = 0; i < 20 && !this.stopped; i++) {
        if (!(await this.attempts.run())) break;
      }
    } catch {
      console.warn(JSON.stringify({ kind: 'payment_reconciliation_unavailable' }));
    } finally {
      this.schedule(1000);
    }
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }
  async onModuleDestroy() {
    await this.stop();
  }
}
