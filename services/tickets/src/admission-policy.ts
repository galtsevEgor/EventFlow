import { admissionWindowSchema, type CheckInInput } from '@eventflow/event-contracts';
import { ApiError, ClientCredentials } from '@eventflow/service-runtime';
import type { TicketsConfig } from './config';

export class AdmissionPolicy {
  private readonly identity: ClientCredentials;

  constructor(private readonly config: TicketsConfig) {
    this.identity = new ClientCredentials(
      config.OIDC_ISSUER,
      'eventflow-policy',
      config.POLICY_CLIENT_SECRET,
    );
  }

  async window(actorSubject: string, { organizationId, eventId }: CheckInInput) {
    try {
      const response = await fetch(new URL('/internal/policy/admission', this.config.CATALOG_URL), {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(4000),
        headers: {
          authorization: `Bearer ${await this.identity.token()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ actorSubject, organizationId, eventId }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 403)
          throw new ApiError(403, 'FORBIDDEN', 'Нет прав на допуск для этого мероприятия.');
        throw new Error('Admission policy unavailable');
      }
      return admissionWindowSchema.parse(await response.json());
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(503, 'POLICY_UNAVAILABLE', 'Не удалось проверить права на допуск.');
    }
  }
}
