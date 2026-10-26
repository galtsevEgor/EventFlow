import { Mailpit, SecretBox } from '@eventflow/service-runtime';
import { Database, type Entry } from './database';
import { Booking } from './booking';
export class OfferMail {
  constructor(
    private readonly db: Database,
    private readonly booking: Booking,
    private readonly box: SecretBox,
    private readonly mail: Mailpit,
    private readonly origin: string,
  ) {}
  async send(id: string) {
    const [entry] = await this.db.query<Entry>('SELECT * FROM waitlist_entry WHERE id=$1', id);
    if (!entry || entry.state !== 'OFFERED' || !entry.order_id) return 'SKIPPED' as const;
    const order = await this.booking.status(entry.id, entry.buyer_subject);
    if (order.state !== 'HELD' || order.expiresAt <= order.serverNow) return 'SKIPPED' as const;
    // Check local cancellation again after the network call.
    const [current] = await this.db.query<{ state: string }>(
      'SELECT state FROM waitlist_entry WHERE id=$1',
      id,
    );
    if (current?.state !== 'OFFERED') return 'SKIPPED' as const;
    return this.mail.send(
      id,
      this.box.open(entry.contact, id),
      'Для вас освободился билет',
      'Билет зарезервирован до ' +
        order.expiresAt.toISOString() +
        '. Оплатить: ' +
        new URL('/orders/' + entry.order_id, this.origin).href,
    );
  }
}
