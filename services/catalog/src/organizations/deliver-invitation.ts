import { Mailpit, type SecretBox } from '@eventflow/service-runtime';
import type { CatalogConfig } from '../config';
import type { Database } from '../database';

export class DeliverInvitation {
  private readonly mail: Mailpit;

  constructor(
    private readonly db: Database,
    private readonly config: CatalogConfig,
    private readonly box: SecretBox,
  ) {
    this.mail = new Mailpit(config.MAILPIT_SMTP_PORT, 'catalog', config.MAILPIT_SMTP_HOST);
  }

  async send(id: string) {
    const invitation = await this.db.invitation.findFirst({
      where: { id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { email: true, deliveryToken: true },
    });
    if (!invitation?.deliveryToken) return 'SKIPPED' as const;
    const url = new URL('/organizer/', this.config.PUBLIC_ORIGIN);
    url.searchParams.set('invite', this.box.open(invitation.deliveryToken, id));
    return this.mail.send(
      id,
      invitation.email,
      'Приглашение в команду EventFlow',
      ['Войдите в EventFlow с адресом, на который отправлено приглашение.', url.href].join('\n\n'),
    );
  }
}
