import { createApiClient, unwrap, ApiRequestError } from '@eventflow/api-client';
import { QueryClient } from '@tanstack/react-query';
import { clearOperatorRequests } from './ops/pending';
import { clearDraftCopies } from './collaboration/cache';

export const api = createApiClient();
export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: 0 }, mutations: { retry: false } },
});
export { unwrap, ApiRequestError };
export type { Schemas } from '@eventflow/api-client';

export async function loadSession() {
  const session = await api.getSession();
  api.setCsrfToken(session.user ? session.csrfToken : '');
  if (!session.user) {
    await import('./gate/database').then((m) => m.gateDatabase.identity(null)).catch(() => {});
    clearOperatorRequests();
    clearDraftCopies();
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'session' });
  }
  return session;
}

export const roles = { OWNER: 'Владелец', MANAGER: 'Менеджер', STAFF: 'Сотрудник' } as const;
