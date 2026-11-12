import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button } from '@eventflow/ui';
import { formatLocalDateTime, formatPercent } from '@eventflow/ui/format';
import { api, unwrap } from './api';
import { ErrorMessage } from './feedback';

const WAITLIST_ANALYTICS_POLL_INTERVAL_MS = 15_000;
const WAITLIST_QUEUE_POLL_INTERVAL_MS = 5_000;

export function WaitlistSettings({
  organizationId,
  eventId,
}: {
  organizationId: string;
  eventId: string;
}) {
  const [open, setOpen] = useState(false),
    path = { org: organizationId, id: eventId };
  const today = new Date().toISOString().slice(0, 10);
  const analytics = useQuery({
    queryKey: ['waitlist-analytics', organizationId, eventId, today],
    enabled: open,
    queryFn: async () =>
      unwrap(
        await api.client.GET('/api/v1/organizations/{id}/analytics/waitlist', {
          params: { path: { id: organizationId }, query: { from: today, to: today, eventId } },
        }),
      ),
    refetchInterval: open ? WAITLIST_ANALYTICS_POLL_INTERVAL_MS : false,
  });
  const query = useQuery({
    queryKey: ['organizer-waitlist', eventId],
    enabled: open,
    queryFn: async () =>
      unwrap(
        await api.client.GET('/api/v1/organizations/{org}/events/{id}/waitlist', {
          params: { path },
        }),
      ),
    refetchInterval: open ? WAITLIST_QUEUE_POLL_INTERVAL_MS : false,
  });
  const change = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.client.PUT('/api/v1/organizations/{org}/events/{id}/waitlist', {
          params: { path },
          body: { enabled: !query.data?.enabled },
        }),
      ),
    onSuccess: async () => {
      await query.refetch();
    },
  });
  return (
    <section>
      <Button variant="secondary" onClick={() => setOpen(!open)} aria-expanded={open}>
        Лист ожидания
      </Button>
      {open && (
        <div>
          <p>Один билет на подписку. Места предлагаются по очереди внутри категории.</p>
          {query.data && (
            <>
              <p>Лист ожидания: {query.data.enabled ? 'включён' : 'отключён'}</p>
              <p>
                Ждут: {query.data.counts.WAITING ?? 0} · Предложений:{' '}
                {query.data.counts.OFFERED ?? 0} · Купили: {query.data.counts.PURCHASED ?? 0}
              </p>
              <Button
                variant="secondary"
                disabled={change.isPending}
                onClick={() => change.mutate()}
              >
                {query.data.enabled ? 'Отключить лист ожидания' : 'Включить лист ожидания'}
              </Button>
            </>
          )}
          {query.data?.enabled && (
            <p className="muted">
              При отключении ожидающие подписки закрываются, неоплаченные предложения отменяются.
              Подтверждённые покупки сохраняются.
            </p>
          )}
          <ErrorMessage error={query.error || change.error} />
          {!!query.data?.entries.length && (
            <details>
              <summary>Последние подписки</summary>
              <ul>
                {query.data.entries.map((e) => (
                  <li key={e.id}>
                    {formatLocalDateTime(e.createdAt)} · {e.categoryId} ·{' '}
                    {(
                      {
                        WAITING: 'ожидает',
                        RESERVING: 'подготавливаем предложение',
                        OFFERED: 'предложен билет',
                        CANCELLING: 'отменяется',
                        PURCHASED: 'куплен билет',
                        EXPIRED: 'срок истёк',
                        CANCELLED: 'отменена',
                        SKIPPED: 'уже есть заказ',
                        CLOSED: 'закрыта',
                      } as Record<string, string>
                    )[e.state] ?? e.state}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {analytics.data && (
            <div aria-label="Эффективность листа ожидания">
              <h4>Подписки сегодня · UTC</h4>
              <p>
                Подписались: {analytics.data.joined} · Получили предложение:{' '}
                {analytics.data.offered} · Купили: {analytics.data.purchased}
              </p>
              <p>Конверсия предложения: {formatPercent(analytics.data.offerConversion)}</p>
              <p className="muted">Покупки подписавшихся сегодня по мере поступления событий.</p>
            </div>
          )}
          <ErrorMessage error={analytics.error} />
        </div>
      )}
    </section>
  );
}
