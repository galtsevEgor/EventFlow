import { z } from 'zod';
import { currentTelemetry } from '@eventflow/telemetry';
import { Broker, MessageWorker } from '@eventflow/messaging';
import { commerceRoutes, realtimeHintSchema, type RealtimeHint } from '@eventflow/event-contracts';
import { SessionStore } from '../auth/session-store';
import type { AuthConfig } from '../auth/config';
import { realtimeHints, realtimeTopic } from './events';

export class RealtimeBus {
  private readonly subscriber;
  private readonly channel: string;
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly disconnects = new Set<() => void>();
  private readonly worker?: MessageWorker;
  private subscribed = false;
  private stopped = true;
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private removeMetrics: (() => void) | undefined;

  constructor(
    config: AuthConfig,
    private readonly store: SessionStore,
  ) {
    this.channel = `eventflow:updates:${config.MESSAGE_NAMESPACE}`;
    this.subscriber = store.client.duplicate({
      commandsQueueMaxLength: 128,
      commandOptions: { timeout: 2000 },
    });
    this.subscriber.on('error', () => this.lost());
    this.subscriber.on('reconnecting', () => this.lost());
    this.subscriber.on('end', () => this.lost());
    if (config.AMQP_URL)
      this.worker = new MessageWorker(
        new Broker({
          url: config.AMQP_URL,
          namespace: config.MESSAGE_NAMESPACE,
          consumer: 'realtime',
          routes: commerceRoutes,
        }),
        undefined,
        async (event) => {
          const hints = realtimeHints(event);
          await store.execute(() =>
            store.client
              .withCommandOptions({ timeout: 2000 })
              .publish(this.channel, JSON.stringify(hints)),
          );
        },
      );
  }
  get ready() {
    return (
      this.subscribed &&
      this.subscriber.isReady &&
      this.store.client.isReady &&
      Boolean(this.worker?.broker.ready)
    );
  }
  private lost() {
    this.subscribed = false;
    for (const close of [...this.disconnects]) close();
  }
  private readonly receive = (raw: string) => {
    if (raw.length > 1024) return;
    try {
      const result = z.array(realtimeHintSchema).max(3).safeParse(JSON.parse(raw));
      if (!result.success) return;
      for (const hint of result.data)
        for (const notify of this.listeners.get(realtimeTopic(hint)) ?? []) notify();
    } catch {
      /* Malformed notifications cannot reach a browser. */
    }
  };
  listen(hint: RealtimeHint, notify: () => void, close: () => void) {
    const key = realtimeTopic(hint),
      listeners = this.listeners.get(key) ?? new Set<() => void>();
    listeners.add(notify);
    this.listeners.set(key, listeners);
    this.disconnects.add(close);
    return () => {
      listeners.delete(notify);
      if (!listeners.size) this.listeners.delete(key);
      this.disconnects.delete(close);
    };
  }
  onModuleInit() {
    this.removeMetrics = currentTelemetry()?.metrics?.supply(['eventflow_dependency_up'], () => [
      {
        name: 'eventflow_dependency_up',
        value: Number(this.store.client.isReady),
        attributes: { component: 'redis' },
      },
    ]);
    if (!this.worker) return;
    this.stopped = false;
    this.worker.start();
    this.schedule(0);
  }
  private schedule(ms: number) {
    if (!this.stopped)
      this.timer = setTimeout(() => {
        this.running = this.tick();
      }, ms);
  }
  private async tick() {
    try {
      if (!this.subscribed) {
        if (!this.subscriber.isOpen) await this.subscriber.connect();
        await this.subscriber.subscribe(this.channel, this.receive);
        this.subscribed = true;
      }
    } catch {
      this.lost();
    } finally {
      this.schedule(2000);
    }
  }
  async onModuleDestroy() {
    this.removeMetrics?.();
    this.stopped = true;
    clearTimeout(this.timer);
    this.lost();
    if (this.subscriber.isOpen) this.subscriber.destroy();
    await this.running?.catch(() => {});
    await this.worker?.stop();
  }
}
