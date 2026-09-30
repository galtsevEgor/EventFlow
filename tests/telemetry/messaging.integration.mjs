import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  Telemetry,
  telemetryConfig,
  currentTraceparent,
} from '../../packages/telemetry/dist/index.js';
import { Broker, MessageWorker, Outbox } from '../../packages/messaging/dist/index.js';
import { realtimeInvalidation, commerceRoutes } from '../../packages/event-contracts/dist/index.js';
import { bookingFixture } from '../helpers/booking.mjs';
import { cleanBroker } from '../helpers/broker.mjs';
import { eventually } from '../helpers/eventually.mjs';
import { readTrace, traceSpans, traceHex } from '../helpers/traces.mjs';

test(
  'persisted outbox context survives a fresh relay and a crash after commit before ack links a retry without another effect',
  { timeout: 90000 },
  async () => {
    const namespace = `eventflow-test-${randomUUID()}`;
    const fixture = await bookingFixture(namespace);
    const config = (service) =>
      telemetryConfig(service, {
        EVENTFLOW_TELEMETRY_ENABLED: 'true',
        EVENTFLOW_TRACE_SAMPLE_RATIO: '1',
      });
    const actor = new Telemetry(config('acceptance')),
      producer = new Telemetry(config('booking')),
      consumer = new Telemetry(config('tickets'));
    let relay, subscriber, event, parent;
    let effects = 0;
    const deliveries = [];
    try {
      await fixture.app.get(MessageWorker).stop();
      await actor.run('acceptance.enqueue', async () => {
        parent = currentTraceparent();
        event = realtimeInvalidation('booking', { scope: 'sale', id: randomUUID() });
        await fixture.db.$transaction((tx) =>
          tx.outbox.create({ data: { id: event.eventId, envelope: event } }),
        );
      });
      await actor.shutdown();
      const stored = await fixture.db.outbox.findUniqueOrThrow({ where: { id: event.eventId } });
      assert.equal(stored.envelope.traceparent, parent);
      subscriber = new Broker({
        url: process.env.AMQP_URL,
        namespace,
        consumer: 'realtime',
        routes: commerceRoutes,
      });
      subscriber.telemetry = consumer;
      await subscriber.open(async (message) => {
        const receipt = await fixture.db.inbox.createMany({
          data: { eventId: message.eventId },
          skipDuplicates: true,
        });
        effects += receipt.count;
        deliveries.push(currentTraceparent());
        if (deliveries.length === 1) throw new Error('private-crash-after-commit');
      });
      const publisher = new Broker({
        url: process.env.AMQP_URL,
        namespace,
        consumer: 'booking',
        routes: commerceRoutes,
      });
      publisher.telemetry = producer;
      relay = new MessageWorker(
        publisher,
        new Outbox((sql, ...values) => fixture.db.$queryRawUnsafe(sql, ...values)),
        async () => {},
      );
      relay.start();
      await eventually(
        () => deliveries.length,
        (count) => count === 2,
        20000,
      );
      assert.equal(effects, 1);
      assert.equal(await fixture.db.inbox.count({ where: { eventId: event.eventId } }), 1);
      const originalId = parent.split('-')[1],
        retryId = deliveries[1].split('-')[1];
      assert.equal(deliveries[0].split('-')[1], originalId);
      assert.notEqual(retryId, originalId);
      const original = await readTrace(originalId, (body) => traceSpans(body).length >= 3);
      assert.ok(!JSON.stringify(original).includes('private'));
      assert.deepEqual(
        new Set(traceSpans(original).map((span) => span.service)),
        new Set(['acceptance', 'booking', 'tickets']),
      );
      const retry = await readTrace(retryId, (body) =>
        traceSpans(body).some((span) => span.name === 'messaging.process'),
      );
      assert.ok(
        traceSpans(retry).some((span) =>
          (span.links ?? []).some((link) => traceHex(link.traceId) === originalId),
        ),
      );
      assert.equal(
        (await fixture.db.outbox.findUniqueOrThrow({ where: { id: event.eventId } })).envelope
          .traceparent,
        parent,
      );
    } finally {
      await relay?.stop();
      await subscriber?.close();
      await producer.shutdown();
      await consumer.shutdown();
      await fixture.close();
      await cleanBroker(namespace);
    }
  },
);
