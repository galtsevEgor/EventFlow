import { ApiError, ClientCredentials, requirePolicy } from '@eventflow/service-runtime';
import type { BookingConfig } from '../config';

export class RefundAccess {
  private readonly identity: ClientCredentials;
  constructor(private readonly config: BookingConfig) {
    this.identity = new ClientCredentials(
      config.OIDC_ISSUER,
      'eventflow-policy',
      config.POLICY_CLIENT_SECRET,
    );
  }
  async check(actorSubject: string, organizationId: string, eventId: string) {
    try {
      await requirePolicy(this.config.CATALOG_URL, await this.identity.token(), {
        actorSubject,
        organizationId,
        eventId,
        action: 'orders:refund',
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, 'POLICY_UNAVAILABLE', 'Не удалось проверить право на возврат.');
    }
  }
}
