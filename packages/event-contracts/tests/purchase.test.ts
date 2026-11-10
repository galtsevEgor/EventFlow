import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  MAX_ORDER_TOTAL_MINOR,
  MAX_SEAT_PRICE_MINOR,
  MAX_SEATS_PER_ORDER,
  orderConfirmedSchema,
  paymentOrderSchema,
  paymentSucceededSchema,
  provisionSchema,
} from '../src/index';

const now = '2035-06-01T16:00:00Z';
const sale = {
  organizationId: randomUUID(),
  title: 'Concert',
  currency: 'EUR',
  timeZone: 'Europe/Chisinau',
  startsAt: now,
  endsAt: now,
  salesStartsAt: now,
  salesEndsAt: now,
  admissionStartsAt: now,
  admissionEndsAt: now,
};
const item = {
  seatId: 'r50-s50',
  row: 50,
  number: 50,
  categoryName: 'Floor',
  priceMinor: MAX_SEAT_PRICE_MINOR,
};
const seat = { ...item, categoryId: 'floor' };
const payment = {
  orderId: randomUUID(),
  buyerSubject: 'buyer',
  amountMinor: MAX_ORDER_TOTAL_MINOR,
  currency: 'EUR',
};

test('the maximum order amount covers every seat at the maximum seat price', () => {
  expect(MAX_ORDER_TOTAL_MINOR).toBe(MAX_SEATS_PER_ORDER * MAX_SEAT_PRICE_MINOR);
  const order = { ...payment, expiresAt: now, serverNow: now, state: 'HELD' };
  expect(paymentOrderSchema.parse(order)).toEqual(order);
  expect(
    paymentOrderSchema.safeParse({ ...order, amountMinor: MAX_ORDER_TOTAL_MINOR + 1 }).success,
  ).toBe(false);
  const items = Array.from({ length: 6 }, (_, index) => ({
    ...item,
    seatId: `r1-s${index + 1}`,
    row: 1,
    number: index + 1,
  }));
  const confirmed = {
    orderId: payment.orderId,
    attemptId: randomUUID(),
    providerPaymentId: 'fake-payment',
    saleId: randomUUID(),
    organizationId: sale.organizationId,
    buyerSubject: payment.buyerSubject,
    title: sale.title,
    totalMinor: payment.amountMinor,
    currency: 'EUR',
    confirmedAt: now,
    items,
  };
  expect(orderConfirmedSchema.parse(confirmed)).toEqual(confirmed);
  expect(orderConfirmedSchema.safeParse({ ...confirmed, items: [...items, item] }).success).toBe(
    false,
  );
});

test('sale snapshots validate stored seat prices and keep support for unmapped legacy IDs', () => {
  expect(provisionSchema.parse({ ...sale, seats: [seat] }).seats).toEqual([seat]);
  const legacySeat = { ...seat, seatId: 'r050-s050' };
  expect(provisionSchema.parse({ ...sale, seats: [legacySeat] }).seats).toEqual([legacySeat]);
  expect(
    provisionSchema.safeParse({
      ...sale,
      seats: [{ ...seat, priceMinor: MAX_SEAT_PRICE_MINOR + 1 }],
    }).success,
  ).toBe(false);
  expect(provisionSchema.safeParse({ ...sale, currency: 'USD', seats: [seat] }).success).toBe(
    false,
  );
});

test('provider-reported currency is accepted for downstream mismatch handling', () => {
  const event = {
    ...payment,
    attemptId: randomUUID(),
    providerPaymentId: 'fake-payment',
    currency: 'USD',
    verifiedAt: now,
    provider: 'fake',
  };
  expect(paymentSucceededSchema.parse(event)).toEqual(event);
});
