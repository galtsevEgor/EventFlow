import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { bookingFixture } from '../helpers/booking.mjs';
import { seedSale } from '../helpers/sale.mjs';
import { cleanBroker } from '../helpers/broker.mjs';
import { MessageWorker } from '../../packages/messaging/dist/index.js';
import { orderStatisticsSchema } from '../../packages/event-contracts/dist/index.js';
import { Reserve } from '../../services/booking/dist/orders/reserve.js';
import { OrderLifecycle } from '../../services/booking/dist/orders/lifecycle.js';

test('reservations publish current snapshots atomically and the migration backfills historical orders', async () => {
  const namespace = 'eventflow-test-' + randomUUID();
  const fixture = await bookingFixture(namespace);
  try {
    await fixture.app.get(MessageWorker).stop();
    const sale = await seedSale(fixture.db);
    const held = (
      await fixture.app
        .get(Reserve)
        .run('historical', randomUUID(), { saleId: sale.id, seatIds: ['r1-s1'] })
    ).body;
    await fixture.app.get(OrderLifecycle).cancel('historical', held.id);
    const current = (await fixture.db.outbox.findMany())
      .map((row) => row.envelope)
      .filter((event) => event.eventType === 'OrderStatisticsChanged.v1');
    assert.deepEqual(current.map((event) => event.data.state).sort(), ['CANCELLED', 'HELD']);
    assert.ok(current.every((event) => orderStatisticsSchema.safeParse(event.data).success));
    const historical = (
      await fixture.app.get(Reserve).run('historical-confirmed', randomUUID(), {
        saleId: sale.id,
        seatIds: ['r1-s2'],
      })
    ).body;
    await fixture.db.order.update({
      where: { id: historical.id },
      data: {
        state: 'CONFIRMED',
        confirmedAt: new Date(),
      },
    });
    const migration = readFileSync(
      'services/booking/prisma/migrations/202611050001_order_statistics/migration.sql',
      'utf8',
    );
    await fixture.db.$executeRawUnsafe(migration);
    const backfill = (await fixture.db.outbox.findMany())
      .map((row) => row.envelope)
      .filter(
        (event) =>
          event.eventType === 'OrderStatisticsChanged.v1' && event.data.state === 'CANCELLED',
      );
    assert.equal(backfill.length, 2);
    assert.deepEqual(
      orderStatisticsSchema.parse(backfill[0].data),
      orderStatisticsSchema.parse(backfill[1].data),
    );
    assert.ok(backfill.every((event) => event.aggregateVersion === 2));
    const restored = await fixture.db.outbox.findFirst({
      where: {
        envelope: { path: ['data', 'orderId'], equals: historical.id },
        AND: { envelope: { path: ['data', 'state'], equals: 'CONFIRMED' } },
      },
    });
    assert.ok(restored);
    assert.equal(orderStatisticsSchema.parse(restored.envelope.data).state, 'CONFIRMED');
    assert.equal(restored.envelope.aggregateVersion, 2);
  } finally {
    await fixture.close();
    await cleanBroker(namespace);
  }
});
