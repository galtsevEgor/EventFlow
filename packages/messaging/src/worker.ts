import type { EventEnvelope } from '@eventflow/event-contracts';
import { Broker } from './broker';
import { Outbox } from './outbox';
import { currentTelemetry } from '@eventflow/telemetry';

const outboxPollIntervalMs = 200;
const reconnectIntervalMs = 2_000;
const consumerHealthIntervalMs = 2_000;
const outboxBatchSize = 20;

export class MessageWorker {
  private stopped = true;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> = Promise.resolve();
  private removeMetrics: (() => void) | undefined;
  constructor(
    readonly broker: Broker,
    private readonly outbox: Outbox | undefined,
    private readonly handle: (event: EventEnvelope) => Promise<void>,
  ) {}
  onModuleInit() {
    this.start();
  }
  start() {
    if (!this.stopped) return;
    this.broker.telemetry ??= currentTelemetry();
    this.removeMetrics ??= this.broker.telemetry?.metrics?.supply(
      ['eventflow_dependency_up'],
      () => [
        {
          name: 'eventflow_dependency_up',
          value: Number(this.broker.ready),
          attributes: { component: 'rabbitmq', consumer: this.broker.config.consumer },
        },
      ],
    );
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
    let delay = outboxPollIntervalMs;
    try {
      if (!this.broker.ready) {
        await this.broker.close();
        if (this.stopped) return;
        await this.broker.open(this.handle);
      }
      if (!this.outbox) {
        delay = consumerHealthIntervalMs;
        return;
      }
      for (let count = 0; count < outboxBatchSize && !this.stopped; count++) {
        const item = await this.outbox.claim();
        if (!item) break;
        try {
          await this.broker.publish(item.envelope);
          await this.outbox.settle(item.id, item.lease, true, item.attempts);
        } catch (error) {
          await this.outbox.settle(item.id, item.lease, false, item.attempts);
          throw error;
        }
      }
    } catch {
      delay = reconnectIntervalMs;
      console.warn(
        JSON.stringify({ kind: 'messaging_unavailable', consumer: this.broker.config.consumer }),
      );
      await this.broker.close();
    } finally {
      this.schedule(delay);
    }
  }
  async onModuleDestroy() {
    await this.stop();
    this.removeMetrics?.();
  }
  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
    await this.broker.close();
  }
}
