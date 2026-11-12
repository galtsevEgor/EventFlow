'use client';
import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { liveQueryPollInterval, unwrap, type Schemas } from '@eventflow/api-client';
import { Alert, Button } from '@eventflow/ui';
import { useBuyer } from './client';
import { useLiveUpdates } from './use-live-updates';

const WAITLIST_ENTRIES_POLL_INTERVAL_MS = 5_000;
const WAITLIST_AVAILABILITY_POLL_INTERVAL_MS = 30_000;
const OFFER_COUNTDOWN_TICK_MS = 1_000;

const labels: Record<Schemas['WaitlistEntry']['state'], string> = {
  WAITING: 'Ожидаем свободное место',
  RESERVING: 'Готовим предложение',
  OFFERED: 'Для вас есть билет',
  CANCELLING: 'Отменяем предложение',
  PURCHASED: 'Билет приобретён',
  EXPIRED: 'Время предложения истекло',
  CANCELLED: 'Подписка отменена',
  SKIPPED: 'У вас уже есть бронь или билет',
  CLOSED: 'Лист ожидания закрыт',
};
const active = ['WAITING', 'RESERVING', 'OFFERED', 'CANCELLING'];
function Entry({ entry }: { entry: Schemas['WaitlistEntry'] }) {
  const { api } = useBuyer(),
    cache = useQueryClient();
  const refresh = useCallback(async () => {
    await cache.invalidateQueries({ queryKey: ['waitlist-entry', entry.id] });
    await cache.invalidateQueries({ queryKey: ['waitlist'] });
  }, [cache, entry.id]);
  const live = useLiveUpdates(
    active.includes(entry.state) ? '/api/v1/waitlist/' + entry.id + '/updates' : null,
    refresh,
  );
  const query = useQuery({
    queryKey: ['waitlist-entry', entry.id],
    initialData: entry,
    queryFn: async () =>
      unwrap(await api.client.GET('/api/v1/waitlist/{id}', { params: { path: { id: entry.id } } })),
    refetchInterval: liveQueryPollInterval(live),
  });
  const cancel = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.client.POST('/api/v1/waitlist/{id}/cancel', {
          params: { path: { id: entry.id } },
          body: {},
        }),
      ),
    onSuccess: refresh,
  });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), OFFER_COUNTDOWN_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  const d = query.data,
    remaining = d.expiresAt
      ? Math.max(0, Date.parse(d.expiresAt) - Date.parse(d.serverNow) - (now - query.dataUpdatedAt))
      : 0;
  return (
    <article
      className="order-card"
      aria-label="Подписка на билет"
      data-live={live ? 'true' : 'false'}
    >
      <h3>{d.title}</h3>
      <p role="status">{labels[d.state]}</p>
      {d.position !== null && <p>Позиция в категории: {d.position}</p>}
      {d.state === 'OFFERED' && <p>На оплату: {Math.ceil(remaining / 1000)} сек.</p>}
      {d.orderId && (
        <a className="back-link" href={'/orders/' + d.orderId}>
          {d.state === 'PURCHASED'
            ? 'Открыть заказ'
            : remaining > 0
              ? 'Оплатить предложение'
              : 'Проверить предложение'}
        </a>
      )}
      {active.includes(d.state) && d.state !== 'CANCELLING' && (
        <Button variant="secondary" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
          Отменить подписку
        </Button>
      )}
      {(query.error || cancel.error) && (
        <Alert>{query.error?.message ?? cancel.error?.message}</Alert>
      )}
    </article>
  );
}
export function BuyerWaitlist() {
  const { api, session } = useBuyer();
  const query = useQuery({
    queryKey: ['waitlist'],
    enabled: !!session.data?.user?.emailVerified,
    queryFn: async () => unwrap(await api.client.GET('/api/v1/waitlist')),
    refetchInterval: WAITLIST_ENTRIES_POLL_INTERVAL_MS,
  });
  if (!session.data?.user?.emailVerified) return null;
  return (
    <section className="buyer-waitlist-panel" aria-label="Мой лист ожидания">
      <h2>Лист ожидания</h2>
      {query.error && <Alert>{query.error.message}</Alert>}
      {query.data?.entries.length === 0 && (
        <p className="muted">Вы пока не подписаны на свободные билеты.</p>
      )}
      {query.data?.entries.map((entry) => (
        <Entry key={entry.id} entry={entry} />
      ))}
    </section>
  );
}
export function EventWaitlist({ saleId }: { saleId: string }) {
  const { api, session } = useBuyer(),
    cache = useQueryClient(),
    [category, setCategory] = useState('');
  const info = useQuery({
    queryKey: ['waitlist-info', saleId],
    queryFn: async () =>
      unwrap(
        await api.client.GET('/api/v1/events/{id}/waitlist', { params: { path: { id: saleId } } }),
      ),
    refetchInterval: WAITLIST_AVAILABILITY_POLL_INTERVAL_MS,
  });
  const entries = useQuery({
    queryKey: ['waitlist'],
    enabled: !!session.data?.user?.emailVerified,
    queryFn: async () => unwrap(await api.client.GET('/api/v1/waitlist')),
    refetchInterval: WAITLIST_ENTRIES_POLL_INTERVAL_MS,
  });
  const join = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.client.POST('/api/v1/waitlist', {
          body: { saleId, categoryId: category || info.data?.categories[0]?.id || '' },
        }),
      ),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ['waitlist'] });
    },
  });
  const current = entries.data?.entries.find(
    (e) => e.saleId === saleId && active.includes(e.state),
  );
  if (current)
    return (
      <section aria-label="Лист ожидания">
        <h2>Лист ожидания</h2>
        <Entry entry={current} />
      </section>
    );
  if (info.error) return <p className="muted">Лист ожидания временно недоступен.</p>;
  if (!info.data?.enabled) return null;
  return (
    <section aria-label="Лист ожидания">
      <h2>Нет подходящих мест?</h2>
      <p>
        Подпишитесь на один билет выбранной категории. Когда место освободится, мы зарезервируем его
        на время и отправим письмо.
      </p>
      {!session.data?.user ? (
        <a href={'/api/v1/auth/login?returnTo=' + encodeURIComponent('/events/' + saleId)}>
          Войти для листа ожидания
        </a>
      ) : !session.data.user.emailVerified ? (
        <p>Подтвердите email для подписки.</p>
      ) : (
        <>
          <label>
            Категория билета{' '}
            <select
              value={category || info.data.categories[0]?.id || ''}
              onChange={(e) => setCategory(e.target.value)}
            >
              {info.data.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <Button
            disabled={join.isPending || entries.isPending || !!entries.error}
            onClick={() => join.mutate()}
          >
            Ждать билет
          </Button>
        </>
      )}
      {(join.error || entries.error) && (
        <Alert>{join.error?.message ?? entries.error?.message}</Alert>
      )}
    </section>
  );
}
