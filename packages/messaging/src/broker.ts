import { randomUUID } from 'node:crypto';
import {
  connect,
  type ChannelModel,
  type ConfirmChannel,
  type ConsumeMessage,
  type Options,
} from 'amqplib';
import { eventEnvelopeSchema, type EventEnvelope } from '@eventflow/event-contracts';

export class PermanentMessageError extends Error {}
export const retryDelays = [5000, 30_000, 120_000, 600_000] as const;
export type BrokerConfig = {
  url: string;
  namespace: string;
  consumer: string;
  routes: Record<string, readonly string[]>;
};

export class Broker {
  private connection: ChannelModel | undefined;
  private channel: ConfirmChannel | undefined;
  private pending = new Map<string, { returned: boolean }>();
  private jobs = new Set<Promise<void>>();
  ready = false;
  constructor(readonly config: BrokerConfig) {}
  get exchange() {
    return `${this.config.namespace}.events`;
  }
  queue(consumer = this.config.consumer) {
    return `${this.config.namespace}.${consumer}`;
  }
  async open(handle: (event: EventEnvelope) => Promise<void>) {
    const connection = await connect(this.config.url, { timeout: 5000 });
    this.connection = connection;
    connection.on('error', () => {
      this.ready = false;
    });
    connection.on('close', () => {
      this.ready = false;
    });
    const channel = await connection.createConfirmChannel();
    this.channel = channel;
    channel.on('error', () => {
      this.ready = false;
    });
    channel.on('close', () => {
      this.ready = false;
    });
    channel.on('return', (message) => {
      const item = this.pending.get(message.properties.messageId ?? '');
      if (item) item.returned = true;
    });
    await channel.assertExchange(this.exchange, 'topic', { durable: true });
    for (const [consumer, types] of Object.entries(this.config.routes)) {
      const queue = this.queue(consumer);
      const args = {
        'x-queue-type': 'quorum',
        'x-overflow': 'reject-publish',
        'x-max-length': 10_000,
      };
      await channel.assertQueue(queue, { durable: true, arguments: args });
      await channel.assertQueue(`${queue}.dlq`, { durable: true, arguments: args });
      for (const type of types) await channel.bindQueue(queue, this.exchange, type);
      for (const delay of retryDelays)
        await channel.assertQueue(`${queue}.retry.${delay}`, {
          durable: true,
          arguments: {
            ...args,
            'x-message-ttl': Math.ceil(delay * 1.2),
            'x-dead-letter-exchange': '',
            'x-dead-letter-routing-key': queue,
            'x-dead-letter-strategy': 'at-least-once',
          },
        });
    }
    await channel.prefetch(4);
    await channel.consume(
      this.queue(),
      (message) => {
        if (!message) {
          this.ready = false;
          return;
        }
        const job = this.deliver(channel, message, handle).catch(() => {
          this.ready = false;
        });
        this.jobs.add(job);
        void job.finally(() => this.jobs.delete(job));
      },
      { noAck: false },
    );
    this.ready = true;
  }
  async publish(event: EventEnvelope) {
    await this.confirm(this.exchange, event.eventType, Buffer.from(JSON.stringify(event)), {
      messageId: event.eventId,
    });
  }
  private async confirm(exchange: string, route: string, body: Buffer, options: Options.Publish) {
    const channel = this.channel;
    if (!channel) throw new Error('Broker not connected');
    // A unique publish ID also distinguishes a redelivery racing the original outbox relay.
    const id = randomUUID();
    const item = { returned: false };
    this.pending.set(id, item);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Publisher confirmation timed out')), 5000);
        try {
          channel.publish(
            exchange,
            route,
            body,
            {
              ...options,
              messageId: id,
              persistent: true,
              mandatory: true,
              contentType: 'application/json',
            },
            (error) => {
              clearTimeout(timer);
              if (error || item.returned) reject(error ?? new Error('Unroutable message'));
              else resolve();
            },
          );
        } catch (error) {
          clearTimeout(timer);
          reject(error);
        }
      });
    } finally {
      this.pending.delete(id);
    }
  }
  private async deliver(
    channel: ConfirmChannel,
    message: ConsumeMessage,
    handle: (event: EventEnvelope) => Promise<void>,
  ) {
    try {
      if (message.content.length > 1024 * 1024)
        throw new PermanentMessageError('Oversized message');
      let event: EventEnvelope;
      try {
        event = eventEnvelopeSchema.parse(JSON.parse(message.content.toString('utf8')));
      } catch {
        throw new PermanentMessageError('Invalid envelope');
      }
      await handle(event);
    } catch (error) {
      const raw = message.properties.headers?.['x-attempt'];
      const attempt = typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : 0;
      const delay = retryDelays[attempt];
      const dead = error instanceof PermanentMessageError || delay === undefined;
      const target = dead ? `${this.queue()}.dlq` : `${this.queue()}.retry.${delay}`;
      // Confirm the copy before acknowledging the original, including on the DLQ path.
      await this.confirm('', target, message.content, {
        headers: { 'x-attempt': attempt + 1 },
        ...(!dead && delay !== undefined
          ? { expiration: String(delay + Math.floor(Math.random() * delay * 0.2)) }
          : {}),
      });
      console.warn(
        JSON.stringify({
          kind: dead ? 'message_dead_lettered' : 'message_retry',
          consumer: this.config.consumer,
          attempt: attempt + 1,
        }),
      );
    }
    channel.ack(message);
  }
  async close() {
    this.ready = false;
    await this.connection?.close().catch(() => {});
    this.connection = undefined;
    this.channel = undefined;
    await Promise.allSettled(this.jobs);
  }
}
