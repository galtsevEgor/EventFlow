'use client';
import { useCallback, useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { liveQueryPollInterval, createApiClient, unwrap } from '@eventflow/api-client';
import { Alert, Button } from '@eventflow/ui';
import { SeatPicker } from './booking/seat-picker';
import { EventWaitlist } from './booking/waitlist';
import { useLiveUpdates } from './booking/use-live-updates';
import { formatEventDateTime, formatPrice } from './format';

const MIN_SALE_BOUNDARY_POLL_INTERVAL_MS = 100;
const SALE_BOUNDARY_CLOCK_MARGIN_MS = 50;

const labels = {
  SCHEDULED: 'Продажи ещё не начались',
  OPEN: 'Продажи открыты',
  PAUSED: 'Продажи приостановлены',
  CLOSED: 'Продажи завершены',
};
function SaleDetails({ id, timeZone }: { id: string; timeZone: string }) {
  const [api] = useState(createApiClient);
  const cache = useQueryClient();
  const refresh = useCallback(async () => {
    await Promise.all([
      cache.cancelQueries({ queryKey: ['sale', id] }),
      cache.cancelQueries({ queryKey: ['orders'] }),
    ]);
    await Promise.all([
      cache.invalidateQueries({ queryKey: ['sale', id] }),
      cache.invalidateQueries({ queryKey: ['orders'] }),
    ]);
  }, [cache, id]);
  const live = useLiveUpdates(`/api/v1/sales/${id}/updates`, refresh);
  const sale = useQuery({
    queryKey: ['sale', id],
    queryFn: async ({ signal }) => {
      const observedAt = performance.now();
      const data = unwrap(
        await api.client.GET('/api/v1/sales/{id}', { params: { path: { id } }, signal }),
      );
      return { data, observedAt };
    },
    refetchInterval: (query) => {
      if (query.state.error) return liveQueryPollInterval(false);
      const snapshot = query.state.data;
      const normal = liveQueryPollInterval(live);
      if (!snapshot) return normal;
      const boundary =
        snapshot.data.state === 'SCHEDULED'
          ? snapshot.data.salesStartsAt
          : snapshot.data.state === 'CLOSED'
            ? null
            : snapshot.data.salesEndsAt;
      return boundary
        ? Math.max(
            MIN_SALE_BOUNDARY_POLL_INTERVAL_MS,
            Math.min(
              normal,
              Date.parse(boundary) -
                Date.parse(snapshot.data.serverNow) -
                (performance.now() - snapshot.observedAt) +
                SALE_BOUNDARY_CLOCK_MARGIN_MS,
            ),
          )
        : normal;
    },
  });
  if (sale.isPending)
    return (
      <p className="sale-loading" role="status">
        Уточняем состояние продаж…
      </p>
    );
  if (sale.isError)
    return (
      <Alert>
        <p>Не удалось получить актуальное состояние продаж.</p>
        <Button variant="secondary" onClick={() => void sale.refetch()}>
          Повторить
        </Button>
      </Alert>
    );
  const data = sale.data.data;
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
        <p>Начало: {formatEventDateTime(data.salesStartsAt, timeZone)}</p>
      )}
      <ul className="price-list">
        {[...categories.entries()].map(([key, category]) => (
          <li key={key}>
            <span>
              {category.name}
              <small>Мест: {category.count}</small>
            </span>
            <strong>{formatPrice(category.price)}</strong>
          </li>
        ))}
      </ul>
      <SeatPicker sale={data} live={live} />
      <EventWaitlist saleId={id} />
      <p className="muted" data-live={live ? 'true' : 'false'}>
        Обновляем свободные места автоматически.
      </p>
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
