'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider, useMutation, useQuery } from '@tanstack/react-query';
import { createApiClient, unwrap } from '@eventflow/api-client';
import { Alert, Button } from '@eventflow/ui';

function AccountControls() {
  const [api] = useState(createApiClient);
  const session = useQuery({
    queryKey: ['session'],
    queryFn: async () => {
      const data = await api.getSession();
      api.setCsrfToken(data.user ? data.csrfToken : '');
      return data;
    },
    refetchInterval: 60_000,
  });
  const logout = useMutation({
    mutationFn: async () => {
      const data = unwrap(await api.client.POST('/api/v1/auth/logout'));
      api.setCsrfToken('');
      location.assign(data.logoutUrl);
    },
  });
  return (
    <nav className="account" aria-label="Аккаунт">
      <a href="/organizer/">Организаторам ↗</a>
      <div className="account-controls">
        {session.isPending ? (
          <span role="status">Загрузка…</span>
        ) : session.data?.user ? (
          <>
            <span className="account-email" title={session.data.user.email}>
              {session.data.user.email}
            </span>
            <a href="/orders">Мои заказы</a>
            <Button variant="secondary" disabled={logout.isPending} onClick={() => logout.mutate()}>
              Выйти
            </Button>
          </>
        ) : (
          <a href="/api/v1/auth/login?returnTo=%2F">Войти</a>
        )}
      </div>
      {(session.error || logout.error) && (
        <Alert>Не удалось проверить аккаунт. Попробуйте обновить страницу.</Alert>
      )}
    </nav>
  );
}

export function Account() {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
  );
  return (
    <QueryClientProvider client={client}>
      <AccountControls />
    </QueryClientProvider>
  );
}
