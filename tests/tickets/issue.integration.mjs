import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { connect } from 'amqplib';
import { message } from '../../packages/event-contracts/dist/index.js';
import { cleanBroker } from '../helpers/broker.mjs';
import { eventually } from '../helpers/eventually.mjs';
import { ticketsDatabase } from '../helpers/tickets-database.mjs';

function worker(namespace, url, crash = false) {
  const child = fork(new URL('../helpers/tickets-child.mjs', import.meta.url), {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
    env: {
      ...process.env,
      TICKETS_DATABASE_URL: url,
      MESSAGE_NAMESPACE: namespace,
      TICKETS_TEST_CRASH: crash ? '1' : '0',
    },
  });
  const received = [];
  const closed = new Promise((resolve) => child.once('close', resolve));
  child.on('message', (entry) => received.push(entry));
  return {
    async wait(type, eventId) {
      return eventually(() => {
        assert.equal(child.exitCode, null, 'Tickets worker exited before sending IPC');
        return received.find((entry) => entry.type === type && entry.eventId === eventId);
      }, Boolean);
    },
    async close(kill = false) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (kill) child.kill('SIGKILL');
      else child.send('stop');
      const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
      try {
        await closed;
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}

test('only Booking confirmations issue tickets, with one immutable issuance across redelivery and workers', async () => {
  const fixture = await ticketsDatabase();
  const namespace = `eventflow-test-${randomUUID()}`;
  const queue = `${namespace}.tickets`;
  const { db } = fixture;
  let connection;
  const workers = [];
  try {
    const first = worker(namespace, fixture.url, true);
    workers.push(first);
    await first.wait('ready');
    connection = await connect(process.env.AMQP_URL);
    const channel = await connection.createConfirmChannel();
    const send = async (event, direct = false) => {
      const payload = Buffer.from(JSON.stringify(event));
      if (direct) channel.sendToQueue(queue, payload, { persistent: true });
      else channel.publish(`${namespace}.events`, event.eventType, payload, { persistent: true });
      await channel.waitForConfirms();
    };
    const orderId = randomUUID();
    const attemptId = randomUUID();
    const items = [1, 2].map((number) => ({
      seatId: `r1-s${number}`,
      row: 1,
      number,
      categoryName: 'Standard',
      priceMinor: 2500,
    }));
    const order = {
      orderId,
      attemptId,
      providerPaymentId: 'fake_verified_fixture',
      saleId: randomUUID(),
      organizationId: randomUUID(),
      buyerSubject: 'buyer-fixture',
      title: 'Ticket fixture',
      totalMinor: 5000,
      currency: 'EUR',
      confirmedAt: new Date().toISOString(),
      items,
    };
    const confirmation = message('booking', 'OrderConfirmed.v1', orderId, 2, order);
    await send(
      message('payments', 'PaymentSucceeded.v1', orderId, 1, {
        orderId,
        attemptId,
        providerPaymentId: order.providerPaymentId,
        buyerSubject: order.buyerSubject,
        amountMinor: order.totalMinor,
        currency: 'EUR',
        verifiedAt: order.confirmedAt,
        provider: 'fake',
      }),
      true,
    );
    await send(message('payments', 'OrderConfirmed.v1', orderId, 2, order));
    await send(message('booking', 'OrderConfirmed.v1', randomUUID(), 2, order));
    await send(
      message('booking', 'OrderConfirmed.v1', orderId, 2, {
        ...order,
        items: [items[0], items[0]],
      }),
    );
    await eventually(
      async () => (await channel.checkQueue(`${queue}.dlq`)).messageCount,
      (count) => count === 4,
    );
    assert.equal(await db.ticket.count(), 0);
    assert.equal(await db.inbox.count(), 0);

    await send(confirmation);
    await first.wait('committed', confirmation.eventId);
    const issued = () => db.ticket.findMany({ orderBy: { seatId: 'asc' } });
    const original = await issued();
    assert.deepEqual(
      original.map(({ seatId }) => seatId),
      ['r1-s1', 'r1-s2'],
    );
    assert.equal(await db.inbox.count(), 1);
    await first.close(true);

    const recovered = worker(namespace, fixture.url);
    workers.push(recovered);
    await recovered.wait('ready');
    await recovered.wait('committed', confirmation.eventId);
    const replica = worker(namespace, fixture.url);
    workers.push(replica);
    await replica.wait('ready');
    const replay = message('booking', 'OrderConfirmed.v1', orderId, 2, order);
    const changedReplay = message('booking', 'OrderConfirmed.v1', orderId, 2, {
      ...order,
      items: [{ ...items[0], number: 3, seatId: 'r1-s3' }],
    });
    await send(replay);
    await send(changedReplay);
    await eventually(
      () => db.inbox.count(),
      (count) => count === 3,
    );
    assert.ok(
      (await issued()).every(
        (ticket, index) =>
          ticket.id === original[index].id && ticket.qrHash === original[index].qrHash,
      ),
    );
    assert.equal(await db.ticket.count(), 2);
  } finally {
    await Promise.all(workers.map((item) => item.close(true)));
    await connection?.close();
    await cleanBroker(namespace);
    await fixture.close();
  }
});
