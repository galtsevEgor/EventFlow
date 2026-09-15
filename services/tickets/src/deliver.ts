import { ClientCredentials, Mailpit } from '@eventflow/service-runtime';
import { z } from 'zod';
import type { TicketsConfig } from './config';

const contact = z.strictObject({ email: z.email().nullable() });

export class DeliverTickets {
  private readonly identity: ClientCredentials;
  private readonly mail: Mailpit;

  constructor(private readonly config: TicketsConfig) {
    this.identity = new ClientCredentials(
      config.OIDC_ISSUER,
      'eventflow-ticket-delivery',
      config.TICKET_DELIVERY_CLIENT_SECRET,
    );
    this.mail = new Mailpit(config.MAILPIT_SMTP_PORT, 'tickets');
  }

  async send(id: string) {
    const response = await fetch(
      new URL(`/internal/orders/${id}/delivery-context`, this.config.BOOKING_URL),
      {
        redirect: 'error',
        signal: AbortSignal.timeout(4000),
        headers: { authorization: `Bearer ${await this.identity.token()}` },
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Delivery context unavailable');
    }
    const { email } = contact.parse(await response.json());
    if (!email) return 'SKIPPED' as const;
    return this.mail.send(
      id,
      email,
      'Ваши билеты EventFlow готовы',
      [
        'Ваши билеты готовы. Войдите в аккаунт EventFlow, чтобы открыть QR своего места.',
        new URL(`/orders/${id}`, this.config.PUBLIC_ORIGIN).href,
      ].join('\n\n'),
    );
  }
}
