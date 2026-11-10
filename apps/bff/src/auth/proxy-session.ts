import type { Request } from 'express';
import type { AuthService } from './auth.service';

export async function requireProxySession(
  auth: AuthService,
  request: Request,
  rate: { scope: string; limit: number },
) {
  const { session } = await auth.requireSession(request);
  if (request.method !== 'GET') auth.assertCsrf(request, session.csrf);
  await auth.store.rateLimit(`${rate.scope}:${session.user.sub}`, rate.limit);
  return session;
}
