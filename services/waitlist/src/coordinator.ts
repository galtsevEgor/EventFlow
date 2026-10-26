import { randomUUID } from 'node:crypto';
import { ApiError, SecretBox } from '@eventflow/service-runtime';
import { Database, type Entry } from './database';
import { Booking, reservationSchema } from './booking';
import { active } from './queue';
import type { WaitlistStep } from './workflow';
export class Coordinator {
  constructor(
    private readonly db: Database,
    private readonly booking: Booking,
    private readonly box: SecretBox,
  ) {}
  private async transition(id: string, from: string[], state: string) {
    return this.db.transaction(async (q) => {
      const [entry] = await q<Entry>(
        `UPDATE waitlist_entry SET state=$3,version=version+1,updated_at=clock_timestamp()
        WHERE id=$1 AND state=ANY($2::text[]) RETURNING *`,
        id,
        from,
        state,
      );
      if (entry) await this.db.changed(q, entry);
      return entry;
    });
  }
  async advance(saleId: string): Promise<WaitlistStep> {
    // A session advisory lock serializes activities, including timed-out workers.
    // The connection is retained across HTTP, but no SQL transaction is held.
    const c = await this.db.pool.connect();
    try {
      const [lock] = (
        await c.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock(hashtextextended($1,190)) AS locked',
          [saleId],
        )
      ).rows;
      if (!lock?.locked) return { stopped: false, wakeAfterMs: 1000 };
      try {
        return await this.step(saleId);
      } finally {
        await c.query('SELECT pg_advisory_unlock(hashtextextended($1,190))', [saleId]);
      }
    } finally {
      c.release();
    }
  }
  private async step(saleId: string): Promise<WaitlistStep> {
    let closed: boolean;
    try {
      closed = (await this.booking.sale(saleId)).state === 'CLOSED';
    } catch (e) {
      if (e instanceof ApiError && e.getStatus() === 404) closed = true;
      else throw e;
    }
    if (closed)
      await this.db.transaction(async (q) => {
        const rows = await q<Entry>(
          `UPDATE waitlist_entry SET state=CASE WHEN state='WAITING' THEN 'CLOSED' ELSE 'CANCELLING' END,
        cancel_reason='CLOSED',version=version+1 WHERE sale_id=$1 AND state=ANY($2::text[]) RETURNING *`,
          saleId,
          ['WAITING', 'RESERVING', 'OFFERED'],
        );
        for (const r of rows) await this.db.changed(q, r);
      });
    const entries = await this.db.query<Entry>(
      'SELECT * FROM waitlist_entry WHERE sale_id=$1 AND state=ANY($2::text[]) ORDER BY sequence',
      saleId,
      active,
    );
    const categories = [...new Set(entries.map((e) => e.category_id))];
    for (const category of categories) {
      let entry =
        entries.find((e) => e.category_id === category && e.state !== 'WAITING') ??
        entries.find((e) => e.category_id === category);
      if (!entry) continue;
      if (entry.state === 'WAITING') {
        const id = entry.id;
        entry = await this.db.transaction(async (q) => {
          // Settings changes lock this row first too.
          const [event] = await q<{ enabled: boolean }>(
            'SELECT enabled FROM waitlist_event WHERE sale_id=$1 FOR UPDATE',
            saleId,
          );
          if (!event?.enabled) return undefined;
          const [head] = await q<Entry>(
            `UPDATE waitlist_entry SET state='RESERVING',attempt_id=$2,version=version+1
            WHERE id=$1 AND state='WAITING' RETURNING *`,
            id,
            randomUUID(),
          );
          return head;
        });
        if (!entry) continue;
      }
      if (!entry.order_id) {
        if (!entry.attempt_id) throw new Error('Missing reservation attempt');
        const result = await this.booking.call('reservations', {
          entryId: entry.id,
          requestId: entry.attempt_id,
          buyerSubject: entry.buyer_subject,
          saleId: entry.sale_id,
          categoryId: entry.category_id,
          email: this.box.open(entry.contact, entry.id),
        });
        if (result.status === 201) {
          const order = reservationSchema.parse(result.body);
          await this.db.transaction(async (q) => {
            const [current] = await q<Entry>(
              'SELECT * FROM waitlist_entry WHERE id=$1 FOR UPDATE',
              entry!.id,
            );
            if (!current || !['RESERVING', 'CANCELLING'].includes(current.state))
              throw new Error('Reservation reconciliation required');
            const state = current.state === 'CANCELLING' ? 'CANCELLING' : 'OFFERED';
            const [next] = await q<Entry>(
              `UPDATE waitlist_entry SET order_id=$2,expires_at=$3,state=$4,version=version+1,updated_at=clock_timestamp()
              WHERE id=$1 RETURNING *`,
              current.id,
              order.id,
              order.expiresAt,
              state,
            );
            if (!next) throw new Error('Missing entry');
            if (state === 'OFFERED')
              await q('INSERT INTO "DeliveryJob"(id) VALUES ($1) ON CONFLICT DO NOTHING', next.id);
            await this.db.changed(q, next);
            entry = next;
          });
        } else {
          const code = (result.body as { code?: string })?.code;
          if (
            !['SEATS_UNAVAILABLE', 'ACTIVE_ORDER', 'ALREADY_PURCHASED', 'SALES_NOT_OPEN'].includes(
              code ?? '',
            )
          )
            throw new Error('Unexpected Booking rejection');
          await this.db.transaction(async (q) => {
            const [current] = await q<Entry>(
              'SELECT * FROM waitlist_entry WHERE id=$1 FOR UPDATE',
              entry!.id,
            );
            if (!current) return;
            const state =
              current.state === 'CANCELLING'
                ? current.cancel_reason
                : ['ACTIVE_ORDER', 'ALREADY_PURCHASED'].includes(code!)
                  ? 'SKIPPED'
                  : 'WAITING';
            const [next] = await q<Entry>(
              'UPDATE waitlist_entry SET state=$2,attempt_id=NULL,version=version+1 WHERE id=$1 RETURNING *',
              current.id,
              state,
            );
            if (next && state !== 'WAITING') await this.db.changed(q, next);
          });
          continue;
        }
      }
      if (!entry) continue;
      // Re-read cancellation committed while Booking was responding.
      const [latest] = await this.db.query<Entry>(
        'SELECT * FROM waitlist_entry WHERE id=$1',
        entry.id,
      );
      if (!latest) throw new Error('Missing entry');
      const status = await this.booking.status(
        latest.id,
        latest.buyer_subject,
        latest.state === 'CANCELLING',
      );
      const state =
        status.state === 'CONFIRMED' || status.state === 'REFUNDED'
          ? 'PURCHASED'
          : status.state === 'EXPIRED'
            ? 'EXPIRED'
            : status.state === 'CANCELLED'
              ? latest.state === 'CANCELLING'
                ? latest.cancel_reason
                : 'CANCELLED'
              : undefined;
      if (state) await this.transition(latest.id, ['OFFERED', 'CANCELLING'], state);
    }
    const [remaining] = await this.db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM waitlist_entry WHERE sale_id=$1 AND state=ANY($2::text[])',
      saleId,
      active,
    );
    return { stopped: Number(remaining?.count ?? 0) === 0, wakeAfterMs: 30000 };
  }
}
