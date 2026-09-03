import { z } from 'zod';
import { ApiError } from './http';

export type PolicyQuery = {
  actorSubject: string;
  organizationId: string;
  eventId?: string;
  action: 'events:read' | 'events:write' | 'members:manage' | 'check-in';
};
export async function requirePolicy(catalogUrl: string, serviceToken: string, query: PolicyQuery) {
  let allowed: boolean;
  try {
    const response = await fetch(new URL('/internal/policy/check', catalogUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${serviceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(query),
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new Error('Policy response unavailable');
    allowed = z.strictObject({ allowed: z.boolean() }).parse(await response.json()).allowed;
  } catch {
    throw new ApiError(
      503,
      'POLICY_UNAVAILABLE',
      'Проверка прав временно недоступна. Действие не выполнено.',
    );
  }
  if (!allowed) throw new ApiError(403, 'FORBIDDEN', 'Недостаточно прав для этого действия.');
}
