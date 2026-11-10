import { z } from 'zod';

export const MAX_SEATS_PER_ORDER = 6;
export const MAX_SEAT_PRICE_MINOR = 100_000_000;
export const MAX_ORDER_TOTAL_MINOR = 600_000_000;

export const EVENT_CURRENCY = 'EUR';
export const eventCurrencySchema = z.literal(EVENT_CURRENCY);
