'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { unwrap } from '@eventflow/api-client';
import { Alert, Button } from '@eventflow/ui';
import { BookingProvider, orderLabels, SignIn, useBuyer } from './client';
import { formatPrice } from '../format';
import { BuyerWaitlist } from './waitlist';

const HELD_ORDERS_POLL_INTERVAL_MS = 5_000;

function List() {
  const { api, session } = useBuyer();
  const [page, setPage] = useState(1);
  const orders = useQuery({
    queryKey: ['orders', page, session.data?.user?.sub],
    enabled: Boolean(session.data?.user),
    queryFn: async ({ signal }) =>
      unwrap(await api.client.GET('/api/v1/orders', { params: { query: { page } }, signal })),
    refetchInterval: (query) =>
      query.state.data?.items.some((item) => item.state === 'HELD')
        ? HELD_ORDERS_POLL_INTERVAL_MS
        : false,
  });
  if (session.isPending) return <p role="status">Проверяем аккаунт…</p>;
  if (session.isError)
    return (
      <Alert>
        Не удалось проверить аккаунт.{' '}
        <Button onClick={() => void session.refetch()}>Повторить</Button>
      </Alert>
    );
  if (!session.data.user) return <SignIn returnTo="/orders" />;
  if (orders.isPending) return <p role="status">Загружаем заказы…</p>;
  if (orders.isError)
    return (
      <Alert>
        Не удалось загрузить заказы.{' '}
        <Button onClick={() => void orders.refetch()}>Повторить</Button>
      </Alert>
    );
  return (
    <>
      {!orders.data.items.length && (
        <p>
          У вас пока нет заказов. <a href="/">Найти мероприятие</a>
        </p>
      )}
      <div className="order-list">
        {orders.data.items.map((order) => (
          <a className="order-summary" href={`/orders/${order.id}`} key={order.id}>
            <strong>{order.title}</strong>
            <span>{orderLabels[order.state]}</span>
            <span>
              {order.items.length} мест · {formatPrice(order.totalMinor)}
            </span>
          </a>
        ))}
      </div>
      <nav className="pagination" aria-label="Страницы заказов">
        <Button variant="secondary" disabled={page === 1} onClick={() => setPage(page - 1)}>
          Назад
        </Button>
        <span>Страница {page}</span>
        <Button
          variant="secondary"
          disabled={page * orders.data.pageSize >= orders.data.total}
          onClick={() => setPage(page + 1)}
        >
          Далее
        </Button>
      </nav>
    </>
  );
}
export function OrderList() {
  return (
    <BookingProvider>
      <List />
      <BuyerWaitlist />
    </BookingProvider>
  );
}
