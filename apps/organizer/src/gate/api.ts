import { api } from '../api';
import { GateSyncError } from './sync';
export async function gateRequest(
  path: 'keys' | 'sessions' | 'sync',
  csrf: string,
  body?: unknown,
) {
  const response = await fetch('/api/v1/offline-check-in/' + path, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(25000),
  });
  const result = (await response.json()) as { message?: string };
  if (!response.ok)
    throw new GateSyncError(
      response.status,
      result.message ?? 'Синхронизация временно недоступна.',
    );
  return result as unknown;
}
export async function gateSession() {
  return api.getSession();
}
