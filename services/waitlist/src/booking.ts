import { z } from 'zod';
import { ApiError, ClientCredentials } from '@eventflow/service-runtime';
export const saleSchema = z.object({
  id: z.uuid(),
  state: z.enum(['OPEN', 'PAUSED', 'SCHEDULED', 'CLOSED']),
  salesEndsAt: z.coerce.date(),
  serverNow: z.coerce.date(),
  seats: z.array(z.object({ categoryId: z.string(), categoryName: z.string(), state: z.string() })),
});
export const reservationSchema = z.object({
  id: z.uuid(),
  expiresAt: z.coerce.date(),
  serverNow: z.coerce.date(),
});
const statusSchema = z.object({
  orderId: z.uuid(),
  state: z.enum(['HELD', 'CONFIRMED', 'EXPIRED', 'CANCELLED', 'REFUNDED']),
  expiresAt: z.coerce.date(),
  serverNow: z.coerce.date(),
});
export class Booking {
  constructor(
    private readonly base: string,
    private readonly identity: ClientCredentials,
  ) {}
  async sale(id: string) {
    const r = await fetch(new URL('/api/v1/sales/' + id, this.base), {
      signal: AbortSignal.timeout(5000),
      redirect: 'error',
    });
    if (r.status === 404) throw new ApiError(404, 'NOT_FOUND', 'Продажа не найдена.');
    if (!r.ok) throw new Error('Booking unavailable');
    return saleSchema.parse(await r.json());
  }
  async call(path: string, body: unknown) {
    const r = await fetch(new URL('/internal/waitlist/' + path, this.base), {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + (await this.identity.token()),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    if (r.status >= 500 || r.status === 401 || r.status === 403)
      throw new Error('Booking unavailable');
    return { status: r.status, body: (await r.json()) as unknown };
  }
  async status(entryId: string, buyerSubject: string, cancel = false) {
    const r = await this.call(cancel ? 'cancel' : 'status', { entryId, buyerSubject });
    if (r.status !== 200) throw new Error('Waitlist reservation missing');
    return statusSchema.parse(r.body);
  }
}
