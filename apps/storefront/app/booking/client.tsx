'use client';
import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { AUTH_SESSION_POLL_INTERVAL_MS, createApiClient } from '@eventflow/api-client';

export const orderLabels = {
  HELD: 'Места забронированы',
  EXPIRED: 'Срок брони истёк',
  CANCELLED: 'Бронь отменена',
  CONFIRMED: 'Заказ подтверждён',
  REFUNDED: 'Оплата возвращена',
};

export function BookingProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
export function useBuyer() {
  const [api] = useState(createApiClient);
  const session = useQuery({
    queryKey: ['buyer-session'],
    queryFn: async () => {
      const result = await api.getSession();
      api.setCsrfToken(result.user ? result.csrfToken : '');
      api.setActor(result.user?.sub ?? '');
      return result;
    },
    refetchInterval: AUTH_SESSION_POLL_INTERVAL_MS,
  });
  if (session.data) {
    api.setCsrfToken(session.data.user ? session.data.csrfToken : '');
    api.setActor(session.data.user?.sub ?? '');
  }
  return { api, session };
}
export function SignIn({ returnTo }: { returnTo: string }) {
  return (
    <p>
      <a className="back-link" href={`/api/v1/auth/login?returnTo=${encodeURIComponent(returnTo)}`}>
        Войдите, чтобы забронировать места
      </a>
    </p>
  );
}
