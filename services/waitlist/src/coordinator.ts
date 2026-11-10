import { randomUUID } from 'node:crypto';
import { ApiError, SecretBox } from '@eventflow/service-runtime';
import { Database, type Entry, type Query } from './database';
import { Booking, reservationSchema } from './booking';
import { active } from './queue';
import type { WaitlistStep } from './workflow';

const COORDINATOR_LOCK_RETRY_MS = 1_000;
const QUEUE_POLL_INTERVAL_MS = 30_000;

type Reservation = ReturnType<typeof reservationSchema.parse>;
type RejectedReservationState = 'WAITING' | 'SKIPPED';

function categoryHeads(entries: Entry[]) {
  // Entries arrive by sequence. Prefer an active reservation without moving its category.
  const heads = new Map<string, Entry>();
  for (const entry of entries) {
    const head = heads.get(entry.category_id);
    if (!head || (head.state === 'WAITING' && entry.state !== 'WAITING'))
      heads.set(entry.category_id, entry);
  }
  return heads.values();
}

async function lockEntry(q: Query, id: string) {
  const [entry] = await q<Entry>('SELECT * FROM waitlist_entry WHERE id=$1 FOR UPDATE', id);
  return entry;
}

export class Coordinator {
  constructor(
    private readonly db: Database,
    private readonly booking: Booking,
    private readonly box: SecretBox,
  ) {}

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
      if (!lock?.locked) return { stopped: false, wakeAfterMs: COORDINATOR_LOCK_RETRY_MS };
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
    if (await this.isSaleClosed(saleId)) await this.closeQueue(saleId);
    const entries = await this.db.query<Entry>(
      'SELECT * FROM waitlist_entry WHERE sale_id=$1 AND state=ANY($2::text[]) ORDER BY sequence',
      saleId,
      active,
    );
    for (const entry of categoryHeads(entries)) await this.advanceEntry(entry);
    const [remaining] = await this.db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM waitlist_entry WHERE sale_id=$1 AND state=ANY($2::text[])',
      saleId,
      active,
    );
    return { stopped: Number(remaining?.count ?? 0) === 0, wakeAfterMs: QUEUE_POLL_INTERVAL_MS };
  }

  private async isSaleClosed(saleId: string) {
    try {
      return (await this.booking.sale(saleId)).state === 'CLOSED';
    } catch (error) {
      if (error instanceof ApiError && error.getStatus() === 404) return true;
      throw error;
    }
  }

  private async closeQueue(saleId: string) {
    await this.db.transaction(async (q) => {
      const rows = await q<Entry>(
        `UPDATE waitlist_entry SET state=CASE WHEN state='WAITING' THEN 'CLOSED' ELSE 'CANCELLING' END,
        cancel_reason='CLOSED',version=version+1 WHERE sale_id=$1 AND state=ANY($2::text[]) RETURNING *`,
        saleId,
        ['WAITING', 'RESERVING', 'OFFERED'],
      );
      for (const entry of rows) await this.db.changed(q, entry);
    });
  }

  private async advanceEntry(head: Entry) {
    const entry = head.state === 'WAITING' ? await this.claimWaitingEntry(head) : head;
    if (!entry) return;
    const reserved = entry.order_id ? entry : await this.requestReservation(entry);
    if (reserved) await this.reconcileOrder(reserved.id);
  }

  private async claimWaitingEntry(entry: Entry) {
    return this.db.transaction(async (q) => {
      // Settings changes lock this row first too.
      const [event] = await q<{ enabled: boolean }>(
        'SELECT enabled FROM waitlist_event WHERE sale_id=$1 FOR UPDATE',
        entry.sale_id,
      );
      if (!event?.enabled) return undefined;
      const [head] = await q<Entry>(
        `UPDATE waitlist_entry SET state='RESERVING',attempt_id=$2,version=version+1
        WHERE id=$1 AND state='WAITING' RETURNING *`,
        entry.id,
        randomUUID(),
      );
      return head;
    });
  }

  private async requestReservation(entry: Entry) {
    if (!entry.attempt_id) throw new Error('Missing reservation attempt');
    const result = await this.booking.call('reservations', {
      entryId: entry.id,
      requestId: entry.attempt_id,
      buyerSubject: entry.buyer_subject,
      saleId: entry.sale_id,
      categoryId: entry.category_id,
      email: this.box.open(entry.contact, entry.id),
    });
    if (result.status === 201)
      return this.recordReservation(entry.id, reservationSchema.parse(result.body));
    const code = (result.body as { code?: string })?.code;
    switch (code) {
      case 'ACTIVE_ORDER':
      case 'ALREADY_PURCHASED':
        await this.recordRejection(entry.id, 'SKIPPED');
        return;
      case 'SEATS_UNAVAILABLE':
      case 'SALES_NOT_OPEN':
        await this.recordRejection(entry.id, 'WAITING');
        return;
      default:
        throw new Error('Unexpected Booking rejection');
    }
  }

  private async recordReservation(id: string, order: Reservation) {
    return this.db.transaction(async (q) => {
      const current = await lockEntry(q, id);
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
      return next;
    });
  }

  private async recordRejection(id: string, rejected: RejectedReservationState) {
    await this.db.transaction(async (q) => {
      const current = await lockEntry(q, id);
      if (!current) return;
      const state = current.state === 'CANCELLING' ? current.cancel_reason : rejected;
      const [next] = await q<Entry>(
        'UPDATE waitlist_entry SET state=$2,attempt_id=NULL,version=version+1 WHERE id=$1 RETURNING *',
        current.id,
        state,
      );
      if (next && state !== 'WAITING') await this.db.changed(q, next);
    });
  }

  private async reconcileOrder(id: string) {
    // Re-read cancellation committed while Booking was responding.
    const [entry] = await this.db.query<Entry>('SELECT * FROM waitlist_entry WHERE id=$1', id);
    if (!entry) throw new Error('Missing entry');
    const cancelling = entry.state === 'CANCELLING';
    const status = await this.booking.status(entry.id, entry.buyer_subject, cancelling);
    switch (status.state) {
      case 'CONFIRMED':
      case 'REFUNDED':
        return this.finishOffer(entry.id, 'PURCHASED');
      case 'EXPIRED':
        return this.finishOffer(entry.id, 'EXPIRED');
      case 'CANCELLED': {
        const state = cancelling ? entry.cancel_reason : 'CANCELLED';
        if (state) return this.finishOffer(entry.id, state);
      }
    }
  }

  private async finishOffer(id: string, state: string) {
    await this.db.transaction(async (q) => {
      const [entry] = await q<Entry>(
        `UPDATE waitlist_entry SET state=$3,version=version+1,updated_at=clock_timestamp()
        WHERE id=$1 AND state=ANY($2::text[]) RETURNING *`,
        id,
        ['OFFERED', 'CANCELLING'],
        state,
      );
      if (entry) await this.db.changed(q, entry);
    });
  }
}
