'use client';
import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LIVE_QUERY_RECHECK_INTERVAL_MS, ApiRequestError, unwrap } from '@eventflow/api-client';
import { Alert, Button } from '@eventflow/ui';
import { BookingProvider, orderLabels, SignIn, useBuyer } from './client';
import { formatPrice } from '../format';
import { PaymentPanel } from './payment-panel';
import { TicketsPanel } from './tickets-panel';
import { RefundPanel } from './refund-panel';
import { useLiveUpdates } from './use-live-updates';

const HOLD_COUNTDOWN_TICK_MS = 250;
const HELD_ORDER_POLL_INTERVAL_MS = 3_000;
const CONFIRMED_ORDER_POLL_INTERVAL_MS = 5_000;
const REFUND_REVIEW_POLL_INTERVAL_MS = 15_000;

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
    const timer = setInterval(() => setTick(performance.now()), HOLD_COUNTDOWN_TICK_MS);
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
  // Cancelled and expired orders can still receive late-payment compensation updates.
  const live = useLiveUpdates(
    buyer && cached?.data.state !== 'REFUNDED' ? `/api/v1/orders/${id}/updates` : null,
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
      if (live && data && !query.state.error) return LIVE_QUERY_RECHECK_INTERVAL_MS;
      if (data?.state === 'HELD') return HELD_ORDER_POLL_INTERVAL_MS;
      if (data?.state === 'CONFIRMED')
        return data.refund?.state === 'REQUIRES_REVIEW'
          ? REFUND_REVIEW_POLL_INTERVAL_MS
          : CONFIRMED_ORDER_POLL_INTERVAL_MS;
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
  if (!session.data.user)
    return <SignIn returnTo={`/orders/${id}`} label="Войти, чтобы открыть заказ" />;
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
    <article className="order-card order-details" data-live={live ? 'true' : 'false'}>
      <header className="order-heading">
        <h1>{data.title}</h1>
        <p className="order-state" data-state={data.state} role="status">
          {orderLabels[data.state]}
        </p>
      </header>
      {data.state === 'HELD' && (
        <div className="order-hold">
          <Countdown
            expiresAt={data.expiresAt}
            serverNow={data.serverNow}
            startedAt={order.data.startedAt}
          />
          <p>Места удерживаются до истечения срока брони.</p>
        </div>
      )}
      <ul className="price-list">
        {data.items.map((item) => (
          <li key={item.seatId}>
            <span>
              Ряд {item.row}, место {item.number}
              <small>{item.categoryName}</small>
            </span>
            <strong>{formatPrice(item.priceMinor)}</strong>
          </li>
        ))}
      </ul>
      <p className="order-total">Итого: {formatPrice(data.totalMinor)}</p>
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
      <p className="order-links">
        <a className="back-link" href={`/events/${data.saleId}`}>
          Вернуться к мероприятию
        </a>
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
