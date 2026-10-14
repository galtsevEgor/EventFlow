import { z } from 'zod';
import { SessionStore } from '../auth/session-store';
import type { DocumentTarget } from './access';

const notification = z.strictObject({ organizationId: z.uuid(), eventId: z.uuid() });
export const roomId = (target: DocumentTarget) => target.organizationId + ':' + target.eventId;

export class CollaborationBus {
  readonly subscriber;
  readonly listeners = new Set<(target: DocumentTarget) => void>();
  private readonly channel;
  constructor(
    private readonly store: SessionStore,
    prefix: string,
  ) {
    this.channel = prefix + 'collaboration';
    this.subscriber = store.client.duplicate();
    this.subscriber.on('error', () => {
      /* Periodic SQL reads repair missed notifications. */
    });
  }
  async onModuleInit() {
    await this.subscriber.connect();
    await this.subscriber.subscribe(this.channel, (raw) => {
      try {
        const parsed = notification.safeParse(JSON.parse(raw));
        if (parsed.success) for (const listener of this.listeners) listener(parsed.data);
      } catch {
        /* Notifications never contain authoritative document state. */
      }
    });
  }
  async publish(target: DocumentTarget) {
    await this.store.execute(() => this.store.client.publish(this.channel, JSON.stringify(target)));
  }
  onModuleDestroy() {
    this.listeners.clear();
    if (this.subscriber.isOpen) this.subscriber.destroy();
  }
}
