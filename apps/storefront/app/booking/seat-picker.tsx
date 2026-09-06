'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiRequestError, unwrap, type Schemas } from '@eventflow/api-client';
import { Alert, Button } from '@eventflow/ui';
import { money, SignIn, useBuyer } from './client';

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
export function SeatPicker({ sale }: { sale: Schemas['PublicSale'] }) {
  const { api, session } = useBuyer();
  if (session.isPending) return <p role="status">Проверяем аккаунт…</p>;
  if (session.isError)
    return (
      <Alert>
        Не удалось проверить аккаунт.{' '}
        <Button onClick={() => void session.refetch()}>Повторить</Button>
      </Alert>
    );
  if (!session.data.user) return <SignIn returnTo={`/events/${sale.id}`} />;
  if (!session.data.user.emailVerified)
    return <Alert>Подтвердите email, чтобы бронировать места.</Alert>;
  return (
    <Selection key={session.data.user.sub} sale={sale} api={api} buyer={session.data.user.sub} />
  );
}
function Selection({
  sale,
  api,
  buyer,
}: {
  sale: Schemas['PublicSale'];
  api: ReturnType<typeof useBuyer>['api'];
  buyer: string;
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
    refetchInterval: 5000,
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
      if (error instanceof ApiRequestError && !error.problem.retryable) {
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
  const columns = Math.max(...sale.seats.map((seat) => seat.number));
  const rows = [...new Set(sale.seats.map((seat) => seat.row))];
  const positions = new Map(sale.seats.map((seat) => [`${seat.row}:${seat.number}`, seat]));
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
      <p className="seat-legend">
        <span>Свободно</span>
        <span>Выбрано</span>
        <span>Занято</span>
      </p>
      <div
        className="seat-map"
        role="region"
        aria-label="Схема мест, прокрутка по горизонтали"
        tabIndex={0}
      >
        <div className="stage">СЦЕНА</div>
        {rows.map((row) => (
          <div
            className="seat-row"
            key={row}
            style={{ gridTemplateColumns: `44px repeat(${columns}, 42px)` }}
          >
            <span className="row-label">Ряд {row}</span>
            {Array.from({ length: columns }, (_, i) => {
              const seat = positions.get(`${row}:${i + 1}`);
              if (!seat) return <span key={i} aria-hidden="true" />;
              const pressed = chosen.some((item) => item.seatId === seat.seatId);
              return (
                <button
                  key={i}
                  type="button"
                  className="seat"
                  aria-pressed={pressed}
                  aria-label={`Ряд ${row}, место ${seat.number}, ${seat.categoryName}, ${money(seat.priceMinor)}${seat.state !== 'AVAILABLE' ? ', занято' : ''}`}
                  disabled={
                    disabled || seat.state !== 'AVAILABLE' || (!pressed && chosen.length >= 6)
                  }
                  onClick={() =>
                    setSelected(
                      pressed
                        ? chosen
                            .filter((item) => item.seatId !== seat.seatId)
                            .map((item) => item.seatId)
                        : [...chosen.map((item) => item.seatId), seat.seatId],
                    )
                  }
                >
                  {seat.number}
                </button>
              );
            })}
          </div>
        ))}
      </div>
      <p aria-live="polite">
        Выбрано: {chosen.length} · {money(chosen.reduce((sum, seat) => sum + seat.priceMinor, 0))}
      </p>
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
      <Button
        disabled={reserve.isPending || (!pending && (disabled || !chosen.length))}
        onClick={() => reserve.mutate()}
      >
        {reserve.isPending ? 'Бронируем…' : pending ? 'Повторить запрос' : 'Забронировать'}
      </Button>
    </section>
  );
}
