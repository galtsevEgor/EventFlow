import { z } from 'zod';

export const ORDER_PAGE_SIZE = 20;
export const orderPageSchema = z.coerce.number().int().min(1).max(10_000).default(1);
