'use client';
import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiRequestError, unwrap } from '@eventflow/api-client';
import { Alert, Button } from '@eventflow/ui';
import { BookingProvider, money, orderLabels, SignIn, useBuyer } from './client';
import { PaymentPanel } from './payment-panel';
import { TicketsPanel } from './tickets-panel';
import { RefundPanel } from './refund-panel';
import { useLiveUpdates } from './use-live-updates';

function Countdown({
  expiresAt,
  serverNow,
  startedAt,
}: {
  expiresAt: string;
  serverNow: string;
  startedAt: number;
}) {
  const [tick, setTick] = useState(() => performance.now());
  useEffect(() => {
    const timer = setInterval(() => setTick(performance.now()), 250);
    return () => clearInterval(timer);
  }, []);
  // Subtract the full request duration conservatively; device wall-clock changes have no effect.
  const seconds = Math.max(
    0,
    Math.floor(
      (Date.parse(expiresAt) - Date.parse(serverNow) - Math.max(0, tick - startedAt)) / 1000,
    ),
  );
  return (
    <p className="countdown" role="timer" aria-label="Осталось до истечения брони">
      {seconds
        ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
        : 'Время истекло. Уточняем статус…'}
    </p>
  );
}
function Details({ id }: { id: string }) {
  const { api, session } = useBuyer();
  const cache = useQueryClient(),
    buyer = session.data?.user?.sub;
  const cached = cache.getQueryData<{ data: { state: string } }>(['order', id, buyer]);
  const refresh = useCallback(async () => {
    await Promise.all(
      ['order', 'payment', 'tickets'].map((key) =>
        cache.cancelQueries({ queryKey: [key, id, buyer] }),
      ),
    );
    await Promise.all(
      ['order', 'payment', 'tickets'].map((key) =>
        cache.invalidateQueries({ queryKey: [key, id, buyer] }),
      ),
    );
  }, [cache, id, buyer]);
  const live = useLiveUpdates(
    buyer && !['REFUNDED', 'EXPIRED', 'CANCELLED'].includes(cached?.data.state ?? '')
      ? `/api/v1/orders/${id}/updates`
      : null,
    refresh,
  );
  useEffect(() => {
    // Redirect parameters are not proof of payment; remove client secrets from browser history.
    const url = new URL(location.href);
    for (const key of ['payment_intent', 'payment_intent_client_secret', 'redirect_status'])
      url.searchParams.delete(key);
    if (url.href !== location.href)
      history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  }, []);
  const order = useQuery({
    queryKey: ['order', id, session.data?.user?.sub],
    enabled: Boolean(session.data?.user),
    queryFn: async ({ signal }) => {
      const startedAt = performance.now();
      const data = unwrap(
        await api.client.GET('/api/v1/orders/{id}', { params: { path: { id } }, signal }),
      );
      return { data, startedAt };
    },
    refetchInterval: (query) => {
      const data = query.state.data?.data;
      if (live && data && ['HELD', 'CONFIRMED'].includes(data.state) && !query.state.error)
        return 30000;
      if (data?.state === 'HELD') return 3000;
      if (data?.state === 'CONFIRMED')
        return data.refund?.state === 'REQUIRES_REVIEW' ? 15000 : 5000;
      return false;
    },
  });
  const cancel = useMutation({
    mutationFn: async () =>
      unwrap(await api.client.POST('/api/v1/orders/{id}/cancel', { params: { path: { id } } })),
    onSuccess: () => void order.refetch(),
  });
  if (session.isPending) return <p role="status">Проверяем аккаунт…</p>;
  if (session.isError)
    return (
      <Alert>
        Не удалось проверить аккаунт.{' '}
        <Button onClick={() => void session.refetch()}>Повторить</Button>
      </Alert>
    );
  if (!session.data.user) return <SignIn returnTo={`/orders/${id}`} />;
  if (order.isPending) return <p role="status">Восстанавливаем заказ…</p>;
  if (order.isError)
    return (
      <Alert>
        {order.error instanceof ApiRequestError
          ? order.error.message
          : 'Не удалось загрузить заказ.'}{' '}
        <Button onClick={() => void order.refetch()}>Повторить</Button>
      </Alert>
    );
  const data = order.data.data;
  return (
    <article className="order-card" data-live={live ? 'true' : 'false'}>
      <p className="eyebrow">ВАШ ЗАКАЗ</p>
      <h1>{data.title}</h1>
      <p className="sale-status" role="status">
        {orderLabels[data.state]}
      </p>
      {data.state === 'HELD' && (
        <>
          <Countdown
            expiresAt={data.expiresAt}
            serverNow={data.serverNow}
            startedAt={order.data.startedAt}
          />
          <p>Места удерживаются до истечения срока брони.</p>
        </>
      )}
      <ul className="price-list">
        {data.items.map((item) => (
          <li key={item.seatId}>
            <span>
              Ряд {item.row}, место {item.number}
              <small>{item.categoryName}</small>
            </span>
            <strong>{money(item.priceMinor)}</strong>
          </li>
        ))}
      </ul>
      <p className="order-total">Итого: {money(data.totalMinor)}</p>
      {data.refund && (
        <RefundPanel
          refund={data.refund}
          totalMinor={data.totalMinor}
          refresh={() => void order.refetch()}
          busy={order.isFetching}
        />
      )}
      {(!data.refund || data.refund.state === 'REJECTED') && (
        <PaymentPanel
          key={`payment:${session.data.user.sub}`}
          id={id}
          buyer={session.data.user.sub}
          orderState={data.state}
          live={live}
          api={api}
        />
      )}
      {data.state === 'CONFIRMED' && (!data.refund || data.refund.state === 'REJECTED') && (
        <TicketsPanel
          key={`tickets:${session.data.user.sub}`}
          order={data}
          buyer={session.data.user.sub}
          api={api}
          live={live}
        />
      )}
      {data.state === 'HELD' && (
        <Button variant="secondary" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
          {cancel.isPending ? 'Отменяем…' : 'Отменить бронь'}
        </Button>
      )}
      {cancel.error && (
        <Alert>Не удалось получить результат отмены. Повторите отмену или обновите статус.</Alert>
      )}
      <p>
        <a className="back-link" href={`/events/${data.saleId}`}>
          Вернуться к мероприятию
        </a>{' '}
        ·{' '}
        <a className="back-link" href="/orders">
          Все заказы
        </a>
      </p>
      <small className="muted">Номер заказа: {data.id}</small>
    </article>
  );
}
export function OrderDetails({ id }: { id: string }) {
  return (
    <BookingProvider>
      <Details id={id} />
    </BookingProvider>
  );
}
