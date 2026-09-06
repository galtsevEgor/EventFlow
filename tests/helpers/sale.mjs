import { randomUUID } from 'node:crypto';

export async function seedSale(db, { seats = 8, ...overrides } = {}) {
  const now = Date.now();
  return db.sale.create({
    data: {
      id: randomUUID(),
      organizationId: randomUUID(),
      version: 1,
      snapshotHash: 'a'.repeat(64),
      title: 'Test concert',
      currency: 'EUR',
      timeZone: 'Europe/Chisinau',
      startsAt: new Date(now + 86400000),
      endsAt: new Date(now + 90000000),
      salesStartsAt: new Date(now - 86400000),
      salesEndsAt: new Date(now + 80000000),
      admissionStartsAt: new Date(now + 82800000),
      admissionEndsAt: new Date(now + 90000000),
      ...overrides,
      seats: {
        create: Array.from({ length: seats }, (_, i) => ({
          seatId: `r1-s${i + 1}`,
          row: 1,
          number: i + 1,
          categoryId: 'standard',
          categoryName: 'Standard',
          priceMinor: 2500 + i,
        })),
      },
    },
  });
}
