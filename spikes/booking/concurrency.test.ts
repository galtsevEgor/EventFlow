import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from './generated/client.ts';
import { reserveSeats, SeatUnavailable } from './reserve-seats.ts';

async function fixture(run: (client: PrismaClient) => Promise<void>) {
  const connectionString = process.env.BOOKING_DATABASE_URL;
  if (!connectionString) throw new Error('BOOKING_DATABASE_URL is required; run pnpm env:init');
  const schema = `e0_${randomUUID().replaceAll('-', '')}`;
  const adapter = new PrismaPg(
    {
      connectionString,
      options: `-c search_path=${schema}`,
      max: 12,
      connectionTimeoutMillis: 5000,
    },
    { schema },
  );
  const client = new PrismaClient({ adapter });
  try {
    // The identifier contains only our fixed prefix and a generated hexadecimal UUID.
    await client.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    await client.$executeRawUnsafe(
      `CREATE TABLE "${schema}".seat (id integer PRIMARY KEY, order_id text)`,
    );
    await client.seat.createMany({ data: [{ id: 1 }, { id: 2 }, { id: 3 }] });
    await run(client);
  } finally {
    try {
      await client.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await client.$disconnect();
    }
  }
}

function transactionBarrier(participants: number) {
  let arrived = 0;
  let release: () => void;
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Concurrent transactions did not start')),
      4000,
    );
    timer.unref();
    release = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  return async (transaction: Prisma.TransactionClient) => {
    await transaction.$executeRaw`SET LOCAL lock_timeout = '2s'`;
    if (++arrived === participants) release();
    await ready;
  };
}

test('eight concurrent transactions cannot reserve the last seat twice', async () =>
  fixture(async (client) => {
    const barrier = transactionBarrier(8);
    const outcomes = await Promise.allSettled(
      Array.from({ length: 8 }, (_, index) =>
        client.$transaction(
          async (tx) => {
            await barrier(tx);
            await reserveSeats(tx, [1], `order-${index}`);
          },
          { timeout: 10000 },
        ),
      ),
    );
    assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
    for (const result of outcomes)
      if (result.status === 'rejected') assert.ok(result.reason instanceof SeatUnavailable);
    assert.equal(await client.seat.count({ where: { orderId: { not: null } } }), 1);
  }));

test('overlapping requests in opposite order use the same lock order without deadlock', async () =>
  fixture(async (client) => {
    const barrier = transactionBarrier(2);
    const outcomes = await Promise.allSettled(
      [
        [2, 1],
        [1, 2],
      ].map((ids, index) =>
        client.$transaction(
          async (tx) => {
            await barrier(tx);
            await reserveSeats(tx, ids, `order-${index}`);
          },
          { timeout: 10000 },
        ),
      ),
    );
    assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
    for (const result of outcomes)
      if (result.status === 'rejected') assert.ok(result.reason instanceof SeatUnavailable);
    const seats = await client.seat.findMany({ where: { id: { in: [1, 2] } } });
    assert.ok(seats[0]?.orderId);
    assert.equal(seats[0]?.orderId, seats[1]?.orderId);
  }));

test('missing seats and transaction failure leave no partial reservation', async () =>
  fixture(async (client) => {
    await assert.rejects(
      client.$transaction((tx) => reserveSeats(tx, [1, 99], 'missing')),
      SeatUnavailable,
    );
    await assert.rejects(
      client.$transaction(async (tx) => {
        await reserveSeats(tx, [1, 2], 'rollback');
        throw new Error('simulated failure before commit');
      }),
      /simulated failure/,
    );
    assert.equal(await client.seat.count({ where: { orderId: { not: null } } }), 0);
  }));
