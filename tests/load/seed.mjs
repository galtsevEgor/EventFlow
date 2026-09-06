import { randomUUID } from 'node:crypto';
import { seedSale } from '../helpers/sale.mjs';

async function mixedInventory(db, sale, offset, historicalBuyerStart, historicalBuyerCount) {
  const now = new Date(),
    expiresAt = new Date(+now + 600000);
  const orders = [],
    items = [],
    slots = [];
  for (let start = 0; start < offset; start += 5) {
    const id = randomUUID(),
      held = start < offset / 2;
    const buyerSubject = `load-buyer-${historicalBuyerStart + ((start / 5) % historicalBuyerCount)}`;
    let totalMinor = 0;
    for (let i = start; i < start + 5; i++) {
      totalMinor += 2500 + i;
      items.push({
        orderId: id,
        saleId: sale.id,
        seatId: `r${Math.floor(i / 50) + 1}-s${(i % 50) + 1}`,
        row: Math.floor(i / 50) + 1,
        number: (i % 50) + 1,
        categoryName: 'Standard',
        priceMinor: 2500 + i,
      });
    }
    orders.push({
      id,
      saleId: sale.id,
      buyerSubject,
      organizationId: sale.organizationId,
      title: sale.title,
      currency: 'EUR',
      totalMinor,
      state: held ? 'HELD' : 'CONFIRMED',
      createdAt: now,
      expiresAt,
    });
    if (held) slots.push({ buyerSubject, saleId: sale.id, currentOrderId: id });
  }
  await db.order.createMany({ data: orders });
  await db.orderItem.createMany({ data: items });
  await db.buyerSaleSlot.createMany({ data: slots });
  await db.$executeRaw`
    UPDATE "SeatInventory" s SET state = CASE WHEN o.state = 'HELD' THEN 'HELD'::"SeatState" ELSE 'SOLD'::"SeatState" END,
      "currentOrderId" = o.id, "expiresAt" = CASE WHEN o.state = 'HELD' THEN o."expiresAt" ELSE NULL END, version = 1
    FROM "OrderItem" i JOIN "Order" o ON o.id = i."orderId"
    WHERE s."saleId" = ${sale.id}::uuid AND i."saleId" = s."saleId" AND i."seatId" = s."seatId"
  `;
}

export async function seedLoad(catalog, booking, identity, smoke) {
  const eventCount = smoke ? 5 : 200,
    capacity = smoke ? 100 : 1000,
    buyerCount = smoke ? 100 : 5000;
  const availableBuyers = smoke ? 80 : 4000,
    offset = smoke ? 20 : 200;
  const organizations = Array.from({ length: smoke ? 2 : 20 }, () => ({
    id: randomUUID(),
    name: 'Synthetic load organizer',
    createdBy: 'load-fixture',
  }));
  await catalog.db.organization.createMany({ data: organizations });
  const sales = [];
  for (let i = 0; i < eventCount; i++) {
    const sale = await seedSale(booking.db, {
      seats: capacity,
      organizationId: organizations[i % organizations.length].id,
      title: `Synthetic concert ${i}`,
    });
    await catalog.db.eventDraft.create({
      data: {
        id: sale.id,
        organizationId: sale.organizationId,
        title: sale.title,
        description: 'Synthetic baseline fixture',
        publicEntry: {
          create: {
            city: i % 2 ? 'Chisinau' : 'Balti',
            address: 'Synthetic Street 1',
            timeZone: sale.timeZone,
            startsAt: sale.startsAt,
            endsAt: sale.endsAt,
            localDate: new Intl.DateTimeFormat('sv-SE', { timeZone: sale.timeZone }).format(
              sale.startsAt,
            ),
            minPriceMinor: 2500,
            currency: 'EUR',
            capacity,
          },
        },
      },
    });
    await mixedInventory(booking.db, sale, offset, availableBuyers, buyerCount - availableBuyers);
    sales.push(sale.id);
  }
  const tokens = [];
  for (let i = 0; i < buyerCount; i++) tokens.push(await identity.token(`load-buyer-${i}`));
  return {
    sales,
    tokens,
    offset,
    availableBuyers,
    shape: {
      events: eventCount,
      capacity,
      buyers: buyerCount,
      organizations: organizations.length,
      initialHeldPerEvent: offset / 2,
      initialSoldPerEvent: offset / 2,
    },
  };
}
