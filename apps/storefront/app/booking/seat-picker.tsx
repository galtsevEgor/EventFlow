'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  liveQueryPollInterval,
  ApiRequestError,
  unwrap,
  type Schemas,
} from '@eventflow/api-client';
import { Alert, Button } from '@eventflow/ui';
import { SignIn, useBuyer } from './client';
import { formatPrice } from '../format';
import { SaleSeats } from './sale-seats';

type Pending = { key: string; seatIds: string[] };
function restore(key: string): Pending | null {
  try {
    const data: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null');
    if (
      data &&
      typeof data === 'object' &&
      'key' in data &&
      'seatIds' in data &&
      typeof data.key === 'string' &&
      /^[a-f0-9-]{36}$/.test(data.key) &&
      Array.isArray(data.seatIds) &&
      data.seatIds.length >= 1 &&
      data.seatIds.length <= 6 &&
      data.seatIds.every((id: unknown) => typeof id === 'string')
    )
      return { key: data.key, seatIds: data.seatIds };
  } catch {
    /* Corrupt browser storage does not define server state. */
  }
  return null;
}
export function SeatPicker({ sale, live }: { sale: Schemas['PublicSale']; live: boolean }) {
  const { api, session } = useBuyer();
  if (session.isPending) return <p role="status">Проверяем аккаунт…</p>;
  if (session.isError)
    return (
      <Alert>
        Не удалось проверить аккаунт.{' '}
        <Button onClick={() => void session.refetch()}>Повторить</Button>
      </Alert>
    );
  if (!session.data.user)
    return (
      <>
        <SignIn returnTo={`/events/${sale.id}`} />
        {sale.seatMap && <SaleSeats sale={sale} selectedIds={[]} disabled onSelect={() => {}} />}
      </>
    );
  if (!session.data.user.emailVerified)
    return <Alert>Подтвердите email, чтобы бронировать места.</Alert>;
  return (
    <Selection
      key={session.data.user.sub}
      sale={sale}
      live={live}
      api={api}
      buyer={session.data.user.sub}
    />
  );
}
function Selection({
  sale,
  api,
  buyer,
  live,
}: {
  sale: Schemas['PublicSale'];
  api: ReturnType<typeof useBuyer>['api'];
  buyer: string;
  live: boolean;
}) {
  const cache = useQueryClient();
  const storageKey = `eventflow:reservation:${buyer}:${sale.id}`;
  const [pending, setPending] = useState(() => restore(storageKey));
  const [selected, setSelected] = useState<string[]>([]);
  const orders = useQuery({
    queryKey: ['orders', sale.id, buyer],
    queryFn: async ({ signal }) =>
      unwrap(
        await api.client.GET('/api/v1/orders', { params: { query: { saleId: sale.id } }, signal }),
      ),
    refetchInterval: (query) => liveQueryPollInterval(live && !query.state.error),
  });
  const active = orders.data?.items.find((order) => order.state === 'HELD');
  const chosen = sale.seats.filter(
    (seat) => selected.includes(seat.seatId) && seat.state === 'AVAILABLE',
  );
  const reserve = useMutation({
    mutationFn: async () => {
      const request = pending ?? {
        key: crypto.randomUUID(),
        seatIds: chosen.map((seat) => seat.seatId),
      };
      // Keep the key before sending; a timeout or refresh must not create a new request.
      sessionStorage.setItem(storageKey, JSON.stringify(request));
      setPending(request);
      return unwrap(
        await api.client.POST('/api/v1/orders', {
          params: { header: { 'Idempotency-Key': request.key } },
          body: { saleId: sale.id, seatIds: request.seatIds },
        }),
      );
    },
    onSuccess: (order) => {
      sessionStorage.removeItem(storageKey);
      location.assign(`/orders/${order.id}`);
    },
    onError: (error) => {
      if (
        error instanceof ApiRequestError &&
        !error.problem.retryable &&
        error.problem.code !== 'INTERNAL_ERROR'
      ) {
        sessionStorage.removeItem(storageKey);
        setPending(null);
        setSelected([]);
      }
      void cache.invalidateQueries({ queryKey: ['sale', sale.id] });
      void orders.refetch();
    },
  });
  const disabled =
    sale.state !== 'OPEN' ||
    Boolean(active) ||
    Boolean(pending) ||
    reserve.isPending ||
    !orders.isSuccess;
  const chosenIds = chosen.map((seat) => seat.seatId);
  function select(id: string) {
    if (disabled || !sale.seats.some((seat) => seat.seatId === id && seat.state === 'AVAILABLE'))
      return;
    if (chosenIds.includes(id)) setSelected(chosenIds.filter((value) => value !== id));
    else if (chosenIds.length < 6) setSelected([...chosenIds, id]);
  }
  return (
    <section className="seat-selection" aria-label="Выбор мест">
      {active && (
        <Alert>
          У вас есть действующая бронь. <a href={`/orders/${active.id}`}>Открыть заказ</a>
        </Alert>
      )}
      {orders.isError && (
        <Alert>
          Не удалось восстановить заказы.{' '}
          <Button onClick={() => void orders.refetch()}>Повторить</Button>
        </Alert>
      )}
      <p className="muted">Выберите от 1 до 6 мест. Бронь действует до 10 минут.</p>
      <SaleSeats sale={sale} selectedIds={chosenIds} disabled={disabled} onSelect={select} />
      {pending && (
        <Alert>
          Сохранили запрос. Повторите его, чтобы узнать результат; новая бронь не создастся.
        </Alert>
      )}
      {reserve.error && (
        <Alert>
          {reserve.error instanceof ApiRequestError
            ? reserve.error.message
            : pending
              ? 'Не удалось получить ответ. Повторите сохранённый запрос.'
              : 'Не удалось сохранить запрос в браузере. Разрешите хранение данных для этого сайта.'}
        </Alert>
      )}
      <div className="seat-checkout">
        <p aria-live="polite">
          Выбрано: {chosen.length} ·{' '}
          <strong>{formatPrice(chosen.reduce((sum, seat) => sum + seat.priceMinor, 0))}</strong>
        </p>
        <Button
          disabled={reserve.isPending || (!pending && (disabled || !chosen.length))}
          onClick={() => reserve.mutate()}
        >
          {reserve.isPending ? 'Бронируем…' : pending ? 'Повторить запрос' : 'Забронировать'}
        </Button>
      </div>
    </section>
  );
}
