import { randomUUID } from 'node:crypto';
import { ApiError, SecretBox } from '@eventflow/service-runtime';
import { Database, type Entry, type Query } from './database';
import { Booking } from './booking';
export const active = ['WAITING', 'RESERVING', 'OFFERED', 'CANCELLING'];
export class WaitlistQueue {
  constructor(
    private readonly db: Database,
    private readonly booking: Booking,
    private readonly box: SecretBox,
  ) {}
  async settings(saleId: string, organizationId: string, title: string, enabled: boolean) {
    await this.db.transaction(async (q) => {
      await q(
        `INSERT INTO waitlist_event(sale_id,organization_id,title,enabled) VALUES ($1,$2,$3,$4)
        ON CONFLICT (sale_id) DO UPDATE SET enabled=$4,title=$3 WHERE waitlist_event.organization_id=$2`,
        saleId,
        organizationId,
        title,
        enabled,
      );
      if (!enabled) {
        const rows = await q<Entry>(
          `UPDATE waitlist_entry SET state=CASE WHEN state='WAITING' THEN 'CLOSED' ELSE 'CANCELLING' END,
          cancel_reason='CLOSED',version=version+1,updated_at=clock_timestamp() WHERE sale_id=$1 AND state=ANY($2::text[]) RETURNING *`,
          saleId,
          active,
        );
        for (const row of rows) await this.db.changed(q, row);
      }
      await this.db.wake(q, saleId);
    });
    return this.summary(saleId);
  }
  async summary(saleId: string) {
    const [event] = await this.db.query<{ enabled: boolean }>(
      'SELECT enabled FROM waitlist_event WHERE sale_id=$1',
      saleId,
    );
    const counts = await this.db.query<{ state: string; count: string }>(
      'SELECT state,count(*)::text AS count FROM waitlist_entry WHERE sale_id=$1 GROUP BY state',
      saleId,
    );
    return {
      enabled: event?.enabled ?? false,
      counts: Object.fromEntries(counts.map((r) => [r.state, Number(r.count)])),
      entries: (
        await this.db.query<{ id: string; category_id: string; state: string; created_at: Date }>(
          'SELECT id,category_id,state,created_at FROM waitlist_entry WHERE sale_id=$1 ORDER BY sequence DESC LIMIT 50',
          saleId,
        )
      ).map((e) => ({
        id: e.id,
        categoryId: e.category_id,
        state: e.state,
        createdAt: e.created_at.toISOString(),
      })),
    };
  }
  async info(saleId: string) {
    const sale = await this.booking.sale(saleId),
      summary = await this.summary(saleId);
    return {
      enabled: summary.enabled && sale.state === 'OPEN',
      state: sale.state,
      categories: [
        ...new Map(
          sale.seats.map((s) => [s.categoryId, { id: s.categoryId, name: s.categoryName }]),
        ).values(),
      ],
    };
  }
  async join(buyer: string, email: string, saleId: string, categoryId: string) {
    const sale = await this.booking.sale(saleId);
    if (sale.state !== 'OPEN')
      throw new ApiError(409, 'SALES_NOT_OPEN', 'Лист ожидания сейчас недоступен.');
    if (!sale.seats.some((s) => s.categoryId === categoryId))
      throw new ApiError(422, 'INVALID_CATEGORY', 'Категория не найдена.');
    return this.db.transaction(async (q) => {
      const [event] = await q<{ enabled: boolean }>(
        'SELECT enabled FROM waitlist_event WHERE sale_id=$1 FOR UPDATE',
        saleId,
      );
      if (!event?.enabled) throw new ApiError(409, 'WAITLIST_DISABLED', 'Лист ожидания отключён.');
      const [existing] = await q<Entry>(
        'SELECT * FROM waitlist_entry WHERE sale_id=$1 AND buyer_subject=$2 AND state=ANY($3::text[])',
        saleId,
        buyer,
        active,
      );
      if (existing) {
        if (existing.category_id !== categoryId)
          throw new ApiError(409, 'ACTIVE_SUBSCRIPTION', 'Сначала отмените текущую подписку.');
        return this.view(q, existing);
      }
      const id = randomUUID();
      const [entry] = await q<Entry>(
        "INSERT INTO waitlist_entry(id,sale_id,buyer_subject,category_id,contact,state) VALUES ($1,$2,$3,$4,$5,'WAITING') RETURNING *",
        id,
        saleId,
        buyer,
        categoryId,
        this.box.seal(email, id),
      );
      if (!entry) throw new Error('Entry not created');
      await this.db.changed(q, entry);
      return this.view(q, entry);
    });
  }
  async view(q: Query, entry: Entry) {
    const [position] = await q<{ position: string }>(
      `SELECT count(*)::text AS position FROM waitlist_entry
      WHERE sale_id=$1 AND category_id=$2 AND state='WAITING' AND sequence<=$3::bigint`,
      entry.sale_id,
      entry.category_id,
      entry.sequence,
    );
    const [event] = await q<{ title: string }>(
      'SELECT title FROM waitlist_event WHERE sale_id=$1',
      entry.sale_id,
    );
    return {
      id: entry.id,
      saleId: entry.sale_id,
      title: event?.title ?? '',
      categoryId: entry.category_id,
      state: entry.state,
      orderId: entry.state === 'OFFERED' || entry.state === 'PURCHASED' ? entry.order_id : null,
      expiresAt: entry.expires_at?.toISOString() ?? null,
      serverNow: new Date().toISOString(),
      position: entry.state === 'WAITING' ? Number(position?.position ?? 0) : null,
      createdAt: entry.created_at.toISOString(),
    };
  }
  async read(buyer: string, id: string) {
    const [entry] = await this.db.query<Entry>(
      'SELECT * FROM waitlist_entry WHERE id=$1 AND buyer_subject=$2',
      id,
      buyer,
    );
    if (!entry) throw new ApiError(404, 'NOT_FOUND', 'Подписка не найдена.');
    return this.view(this.db.query, entry);
  }
  async list(buyer: string) {
    const rows = await this.db.query<Entry>(
      "SELECT * FROM waitlist_entry WHERE buyer_subject=$1 ORDER BY CASE WHEN state IN ('WAITING','RESERVING','OFFERED','CANCELLING') THEN 0 ELSE 1 END,sequence DESC LIMIT 50",
      buyer,
    );
    return { entries: await Promise.all(rows.map((row) => this.view(this.db.query, row))) };
  }
  async cancel(buyer: string, id: string) {
    await this.db.transaction(async (q) => {
      const [entry] = await q<Entry>(
        'SELECT * FROM waitlist_entry WHERE id=$1 AND buyer_subject=$2 FOR UPDATE',
        id,
        buyer,
      );
      if (!entry) throw new ApiError(404, 'NOT_FOUND', 'Подписка не найдена.');
      if (!active.includes(entry.state) || entry.state === 'CANCELLING') return;
      const [next] = await q<Entry>(
        `UPDATE waitlist_entry SET state=CASE WHEN state='WAITING' THEN 'CANCELLED' ELSE 'CANCELLING' END,
        cancel_reason='CANCELLED',version=version+1,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
        id,
      );
      if (next) await this.db.changed(q, next);
    });
    return this.read(buyer, id);
  }
}
