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
    this.mail = new Mailpit(config.MAILPIT_SMTP_PORT, 'tickets', config.MAILPIT_SMTP_HOST);
  }

  async send(id: string) {
    const email = await this.email(id, 'delivery-context');
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

  async refund(operationId: string, orderId: string) {
    const email = await this.email(orderId, 'refund-delivery-context');
    if (!email) return 'SKIPPED' as const;
    return this.mail.send(
      operationId,
      email,
      'Возврат оплаты EventFlow выполнен',
      [
        'Возврат полной стоимости заказа выполнен. Билеты аннулированы. Срок зачисления зависит от банка.',
        new URL(`/orders/${orderId}`, this.config.PUBLIC_ORIGIN).href,
      ].join('\n\n'),
    );
  }

  private async email(id: string, endpoint: 'delivery-context' | 'refund-delivery-context') {
    const response = await fetch(
      new URL(`/internal/orders/${id}/${endpoint}`, this.config.BOOKING_URL),
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
    return email;
  }
}
