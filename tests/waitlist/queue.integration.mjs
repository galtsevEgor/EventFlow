import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { waitlistFixture } from '../helpers/waitlist.mjs';
import { Reserve } from '../../services/booking/dist/orders/reserve.js';
import { OrderLifecycle } from '../../services/booking/dist/orders/lifecycle.js';
import { Coordinator } from '../../services/waitlist/dist/coordinator.js';
import { OfferMail } from '../../services/waitlist/dist/mail.js';
import { MailQueue, Mailpit } from '../../packages/service-runtime/dist/index.js';
import { ageOrder } from '../helpers/order.mjs';
import { WaitlistMetrics } from '../../services/waitlist/dist/metrics.js';
let f;
before(async () => {
  f = await waitlistFixture();
});
after(async () => {
  await f?.close();
});
async function reset() {
  await f.db.query('TRUNCATE "DeliveryJob","Outbox",waitlist_entry');
  await f.booking.db.buyerSaleSlot.deleteMany();
  await f.booking.db.seatInventory.updateMany({
    data: { state: 'AVAILABLE', currentOrderId: null, expiresAt: null },
  });
  await f.booking.db.orderItem.deleteMany();
  await f.booking.db.order.deleteMany();
  await f.queue.settings(f.sale.id, f.sale.organizationId, f.sale.title, true);
}
test('concurrent joins are idempotent, FIFO positions are private, contacts are encrypted', async () => {
  await reset();
  const rows = await Promise.all(Array.from({ length: 20 }, () => f.join('first')));
  assert.equal(new Set(rows.map((e) => e.id)).size, 1);
  const second = await f.join('second');
  assert.equal(second.position, 2);
  await assert.rejects(
    () => f.queue.read('outsider', rows[0].id),
    (e) => e.getStatus() === 404,
  );
  const [stored] = await f.db.query('SELECT contact FROM waitlist_entry WHERE id=$1', rows[0].id);
  assert.ok(!stored.contact.toString().includes('first@eventflow.test'));
  const outbox = await f.db.query('SELECT envelope FROM "Outbox"');
  assert.ok(outbox.every((e) => !JSON.stringify(e).includes('@eventflow.test')));
  await f.queue.cancel('first', rows[0].id);
  assert.equal((await f.queue.read('second', second.id)).position, 1);
});
test('release promotes only the FIFO head and concurrent activities do not double reserve', async () => {
  await reset();
  const normal = await f.booking.app
    .get(Reserve)
    .run('normal', randomUUID(), { saleId: f.sale.id, seatIds: ['r1-s1'] });
  const first = await f.join('first'),
    second = await f.join('second');
  await f.coordinator.advance(f.sale.id);
  assert.equal((await f.queue.read('first', first.id)).state, 'WAITING');
  await f.booking.app.get(OrderLifecycle).cancel('normal', normal.body.id);
  await Promise.all(Array.from({ length: 8 }, () => f.coordinator.advance(f.sale.id)));
  const offered = await f.queue.read('first', first.id);
  assert.equal(offered.state, 'OFFERED');
  assert.ok(offered.orderId);
  assert.equal((await f.queue.read('second', second.id)).state, 'WAITING');
  assert.equal(await f.booking.db.order.count({ where: { state: 'HELD' } }), 1);
});
test('expired offers advance the queue and old mail is suppressed', async () => {
  const first = (await f.queue.list('first')).entries[0],
    second = (await f.queue.list('second')).entries[0];
  await ageOrder(f.booking.db, first.orderId);
  await f.coordinator.advance(f.sale.id);
  await f.coordinator.advance(f.sale.id);
  assert.equal((await f.queue.read('first', first.id)).state, 'EXPIRED');
  assert.equal((await f.queue.read('second', second.id)).state, 'OFFERED');
  const mail = new OfferMail(
    f.db,
    f.api,
    f.box,
    {
      send() {
        throw new Error('Stale mail must not send');
      },
    },
    process.env.PUBLIC_ORIGIN,
  );
  assert.equal(await mail.send(first.id), 'SKIPPED');
});
test('lost Booking acknowledgement plus cancellation reconciles and releases exactly the original offer', async () => {
  await reset();
  const entry = await f.join('lost-ack');
  let lose = true;
  const unreliable = {
    sale: (id) => f.api.sale(id),
    status: (...v) => f.api.status(...v),
    async call(...v) {
      const result = await f.api.call(...v);
      if (lose) {
        lose = false;
        throw new Error('lost ACK');
      }
      return result;
    },
  };
  const broken = new Coordinator(f.db, unreliable, f.box);
  await assert.rejects(() => broken.advance(f.sale.id), /lost ACK/);
  const [pending] = await f.db.query(
    'SELECT state,attempt_id FROM waitlist_entry WHERE id=$1',
    entry.id,
  );
  assert.equal(pending.state, 'RESERVING');
  assert.ok(pending.attempt_id);
  await f.queue.cancel('lost-ack', entry.id);
  assert.equal((await f.queue.read('lost-ack', entry.id)).state, 'CANCELLING');
  await f.coordinator.advance(f.sale.id);
  assert.equal((await f.queue.read('lost-ack', entry.id)).state, 'CANCELLED');
  assert.equal(await f.booking.db.order.count(), 1);
  assert.equal(await f.booking.db.order.count({ where: { state: 'HELD' } }), 0);
  assert.equal((await f.db.query('SELECT * FROM "DeliveryJob"')).length, 0);
});
test('confirmed payment wins late cancellation; disabling closes remaining subscriptions', async () => {
  await reset();
  const first = await f.join('paid'),
    second = await f.join('next');
  await f.coordinator.advance(f.sale.id);
  const offer = await f.queue.read('paid', first.id);
  await f.booking.db.order.update({
    where: { id: offer.orderId },
    data: { state: 'CONFIRMED', confirmedAt: new Date() },
  });
  await f.queue.cancel('paid', first.id);
  await f.coordinator.advance(f.sale.id);
  assert.equal((await f.queue.read('paid', first.id)).state, 'PURCHASED');
  await f.queue.settings(f.sale.id, f.sale.organizationId, f.sale.title, false);
  assert.equal((await f.queue.read('next', second.id)).state, 'CLOSED');
  await assert.rejects(
    () => f.join('disabled'),
    (e) => e.getStatus() === 409,
  );
});
test('mail retries are persisted and the real Mailpit message contains only the scoped order link', async () => {
  await reset();
  const entry = await f.join('mail');
  await f.coordinator.advance(f.sale.id);
  const queue = new MailQueue(async (sql, ...v) => f.db.query(sql, ...v));
  let sends = 0;
  const mail = new OfferMail(
    f.db,
    f.api,
    f.box,
    {
      async send(...v) {
        if (++sends === 1) throw new Error('SMTP unavailable');
        return new Mailpit(Number(process.env.MAILPIT_SMTP_PORT), 'waitlist').send(...v);
      },
    },
    process.env.PUBLIC_ORIGIN,
  );
  const first = await queue.claim();
  assert.equal(first.id, entry.id);
  await assert.rejects(() => mail.send(first.id), /SMTP unavailable/);
  await queue.settle(first);
  assert.equal(
    (await f.db.query('SELECT state,attempts FROM "DeliveryJob" WHERE id=$1', entry.id))[0].state,
    'PENDING',
  );
  await f.db.query('UPDATE "DeliveryJob" SET "nextRunAt"=clock_timestamp() WHERE id=$1', entry.id);
  const retry = await queue.claim();
  assert.equal(retry.attempts, 2);
  assert.equal(await mail.send(retry.id), 'SENT');
  await queue.settle(retry, 'SENT');
  const list = await (
    await fetch(
      process.env.MAILPIT_URL +
        '/api/v1/search?query=' +
        encodeURIComponent('to:mail@eventflow.test'),
    )
  ).json();
  assert.ok(list.messages.length > 0);
  const message = await (
    await fetch(process.env.MAILPIT_URL + '/api/v1/message/' + list.messages[0].ID)
  ).json();
  const offer = await f.queue.read('mail', entry.id);
  assert.ok(message.Text.includes('/orders/' + offer.orderId));
  assert.ok(!message.Text.includes(entry.id));
});
test('100 participants at concurrency 10 keep a single active offer and bounded private metrics', async (t) => {
  await reset();
  const times = [];
  for (let page = 0; page < 10; page++)
    await Promise.all(
      Array.from({ length: 10 }, async (_, i) => {
        const before = performance.now();
        await f.join('load-' + (page * 10 + i));
        times.push(performance.now() - before);
      }),
    );
  const positions = await f.db.query('SELECT sequence FROM waitlist_entry ORDER BY sequence');
  assert.equal(positions.length, 100);
  await f.coordinator.advance(f.sale.id);
  await f.coordinator.advance(f.sale.id);
  const measures = await new WaitlistMetrics(f.db).collect();
  assert.equal(
    measures.find(
      (m) => m.name === 'eventflow_waitlist_entries' && m.attributes.state === 'OFFERED',
    ).value,
    1,
  );
  assert.equal(
    measures.find(
      (m) => m.name === 'eventflow_waitlist_entries' && m.attributes.state === 'WAITING',
    ).value,
    99,
  );
  assert.equal(await f.booking.db.order.count(), 1);
  assert.ok(!JSON.stringify(measures).includes(f.sale.id));
  times.sort((a, b) => a - b);
  t.diagnostic(
    JSON.stringify({ participants: 100, concurrency: 10, p95Ms: Math.round(times[94]) }),
  );
});
