'use client';
import { useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { createApiClient, unwrap } from '@eventflow/api-client';
import { Alert, Button } from '@eventflow/ui';

const labels = {
  SCHEDULED: 'Продажи ещё не начались',
  OPEN: 'Продажи открыты',
  PAUSED: 'Продажи приостановлены',
  CLOSED: 'Продажи завершены',
};
function SaleDetails({ id, timeZone }: { id: string; timeZone: string }) {
  const [api] = useState(createApiClient);
  const sale = useQuery({
    queryKey: ['sale', id],
    queryFn: async ({ signal }) =>
      unwrap(await api.client.GET('/api/v1/sales/{id}', { params: { path: { id } }, signal })),
    refetchInterval: 5000,
  });
  if (sale.isPending) return <p role="status">Уточняем состояние продаж…</p>;
  if (sale.isError)
    return (
      <Alert>
        <p>Не удалось получить актуальное состояние продаж.</p>
        <Button variant="secondary" onClick={() => void sale.refetch()}>
          Повторить
        </Button>
      </Alert>
    );
  const data = sale.data;
  const categories = new Map<string, { name: string; price: number; count: number }>();
  for (const seat of data.seats) {
    const category = categories.get(seat.categoryId) ?? {
      name: seat.categoryName,
      price: seat.priceMinor,
      count: 0,
    };
    category.count++;
    categories.set(seat.categoryId, category);
  }
  return (
    <div>
      <p className={`sale-status sale-${data.state.toLowerCase()}`} role="status">
        {labels[data.state]}
      </p>
      {data.state === 'SCHEDULED' && (
        <p>
          Начало:{' '}
          {new Intl.DateTimeFormat('ru', {
            dateStyle: 'long',
            timeStyle: 'short',
            timeZone,
          }).format(new Date(data.salesStartsAt))}
        </p>
      )}
      <ul className="price-list">
        {[...categories.entries()].map(([key, category]) => (
          <li key={key}>
            <span>
              {category.name}
              <small>{category.count} мест</small>
            </span>
            <strong>
              {new Intl.NumberFormat('ru', { style: 'currency', currency: 'EUR' }).format(
                category.price / 100,
              )}
            </strong>
          </li>
        ))}
      </ul>
      <p className="muted">Онлайн-бронирование скоро появится.</p>
    </div>
  );
}
export function SalePanel(props: { id: string; timeZone: string }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return (
    <QueryClientProvider client={client}>
      <SaleDetails {...props} />
    </QueryClientProvider>
  );
}
