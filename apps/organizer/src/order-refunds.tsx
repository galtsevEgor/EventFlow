import { useCallback, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, Dialog, EmptyState, Field, Loading, Select } from '@eventflow/ui';
import { formatLocalDateTime, formatMoney } from '@eventflow/ui/format';
import { api, queryClient, unwrap, type Schemas } from './api';
import { eventListOptions } from './event-queries';
import { ErrorMessage } from './feedback';
import { useLiveUpdates } from './use-live-updates';
import { liveQueryPollInterval } from '@eventflow/api-client';

const states = {
  FENCING: 'Проверяем билеты',
  PENDING: 'Возврат обрабатывается',
  REQUIRES_REVIEW: 'Требуется проверка поддержки',
  REJECTED: 'Возврат отклонён',
  SUCCEEDED: 'Оплата возвращена',
} satisfies Record<Schemas['OrderRefund']['state'], string>;
const rejection = (code: string | null) =>
  code === 'TICKETS_USED'
    ? 'Один из билетов уже использован.'
    : code === 'REFUND_WINDOW_CLOSED'
      ? 'Срок возврата закончился.'
      : 'Состав билетов требует проверки поддержки.';

function RefundDialog({
  organizationId,
  order,
  close,
}: {
  organizationId: string;
  order: Schemas['OrganizerOrder'];
  close: () => void;
}) {
  const [reason, setReason] = useState('');
  const refund = useMutation({
    mutationFn: async () => {
      const storageKey = `eventflow:refund:${organizationId}:${order.id}`;
      let key = sessionStorage.getItem(storageKey);
      if (!key || !/^[a-f0-9-]{36}$/.test(key)) key = crypto.randomUUID();
      sessionStorage.setItem(storageKey, key);
      return unwrap(
        await api.client.POST(
          '/api/v1/organizations/{organizationId}/events/{eventId}/orders/{id}/refund',
          {
            params: {
              path: { organizationId, eventId: order.saleId, id: order.id },
              header: { 'Idempotency-Key': key },
            },
            body: { reason: reason.trim() },
          },
        ),
      );
    },
    onSuccess: close,
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: ['organizer-orders', organizationId] }),
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !refund.isPending) close();
      }}
      title="Вернуть оплату заказа"
      description="Полный возврат доступен до начала мероприятия, если ни один билет не использован."
    >
      <p>
        К возврату <strong>{formatMoney(order.totalMinor, order.currency)}</strong>. Все билеты
        заказа будут аннулированы.
      </p>
      <p className="muted">Заказ {order.id}</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          refund.mutate();
        }}
      >
        <Field
          label="Причина возврата"
          value={reason}
          required
          minLength={2}
          maxLength={240}
          disabled={refund.isPending}
          onChange={(event) => setReason(event.target.value)}
        />
        <ErrorMessage error={refund.error} />
        {refund.error && (
          <p>Ответ мог потеряться. Обновите список или повторите запрос с той же причиной.</p>
        )}
        <Button
          type="submit"
          variant="danger"
          disabled={refund.isPending || reason.trim().length < 2}
        >
          {refund.isPending
            ? 'Отправляем…'
            : `Вернуть ${formatMoney(order.totalMinor, order.currency)}`}
        </Button>
      </form>
    </Dialog>
  );
}

export function OrderRefunds({ id }: { id: string }) {
  const [eventId, setEventId] = useState('');
  const events = useQuery(eventListOptions(id));
  const published =
    events.data?.events.filter((event) => event.publication?.state === 'PUBLISHED') ?? [];
  const selected = eventId || published[0]?.id;
  return (
    <section aria-label="Заказы и возвраты">
      <h2>Заказы и возвраты</h2>
      <p>
        Полный возврат до начала мероприятия. При возврате билеты блокируются, затем аннулируются.
      </p>
      <ErrorMessage error={events.error} />
      {events.isPending && <Loading />}
      {published.length > 0 ? (
        <>
          <Select
            label="Мероприятие для заказов"
            value={selected}
            onChange={(event) => setEventId(event.target.value)}
          >
            {published.map((event) => (
              <option key={event.id} value={event.id}>
                {event.title}
              </option>
            ))}
          </Select>
          {selected && <OrderList key={selected} organizationId={id} eventId={selected} />}
        </>
      ) : (
        !events.isPending &&
        !events.isError && (
          <EmptyState title="Нет опубликованных мероприятий">
            Заказы появятся после публикации мероприятия и оплаты билетов.
          </EmptyState>
        )
      )}
    </section>
  );
}

function OrderList({ organizationId, eventId }: { organizationId: string; eventId: string }) {
  const refresh = useCallback(async () => {
    await Promise.all([
      queryClient.cancelQueries({ queryKey: ['organizer-orders', organizationId, eventId] }),
      queryClient.cancelQueries({ queryKey: ['sales-statistics', organizationId] }),
    ]);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['organizer-orders', organizationId, eventId] }),
      queryClient.invalidateQueries({ queryKey: ['sales-statistics', organizationId] }),
    ]);
  }, [organizationId, eventId]);
  const live = useLiveUpdates(
    `/api/v1/organizations/${organizationId}/events/${eventId}/orders/updates`,
    refresh,
  );
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Schemas['OrganizerOrder'] | null>(null);
  const list = useQuery({
    queryKey: ['organizer-orders', organizationId, eventId, page],
    refetchInterval: (query) => liveQueryPollInterval(live && !query.state.error),
    queryFn: async () =>
      unwrap(
        await api.client.GET('/api/v1/organizations/{organizationId}/events/{eventId}/orders', {
          params: { path: { organizationId, eventId }, query: { page } },
        }),
      ),
  });
  return (
    <div data-live={live ? 'true' : 'false'}>
      <Button variant="secondary" disabled={list.isFetching} onClick={() => void list.refetch()}>
        Обновить заказы
      </Button>
      <ErrorMessage error={list.error} />
      {list.isPending && <Loading />}
      {!list.isError && list.data && (
        <>
          <p>Оплаченных заказов {list.data.total}</p>
          {list.data.orders.length === 0 && (
            <EmptyState title="Заказов пока нет">
              Здесь появятся оплаченные заказы этого мероприятия.
            </EmptyState>
          )}
          <div className="refund-orders">
            {list.data.orders.map((order) => (
              <article className="refund-order" key={order.id} aria-label={`Заказ ${order.id}`}>
                <h3>Заказ {order.id}</h3>
                <p>
                  {formatMoney(order.totalMinor, order.currency)} · мест {order.items.length}
                </p>
                <p className="muted">
                  Создан {formatLocalDateTime(order.createdAt)} · возврат до{' '}
                  {formatLocalDateTime(order.refundDeadline)}
                </p>
                <Badge>{order.refund ? states[order.refund.state] : 'Заказ подтверждён'}</Badge>
                {order.refund && (
                  <>
                    <p>Причина {order.refund.reason}</p>
                    {order.refund.state === 'REJECTED' && <p>{rejection(order.refund.code)}</p>}
                    {order.refund.state === 'REQUIRES_REVIEW' && (
                      <p>Билеты остаются заблокированными. Передайте номер операции поддержке.</p>
                    )}
                    <small className="muted">Операция {order.refund.id}</small>
                  </>
                )}
                {order.canRequestRefund && (
                  <p>
                    <Button variant="danger" onClick={() => setSelected(order)}>
                      Оформить возврат
                    </Button>
                  </p>
                )}
                {!order.refund && !order.canRequestRefund && <p>Срок возврата закончился.</p>}
              </article>
            ))}
          </div>
          <div className="pagination">
            <Button
              variant="secondary"
              disabled={page <= 1 || list.isFetching}
              onClick={() => setPage(page - 1)}
            >
              Предыдущие заказы
            </Button>
            <span>
              Страница {page} из {Math.max(1, list.data.pages)}
            </span>
            <Button
              variant="secondary"
              disabled={page >= list.data.pages || list.isFetching}
              onClick={() => setPage(page + 1)}
            >
              Следующие заказы
            </Button>
          </div>
        </>
      )}
      {selected && (
        <RefundDialog
          organizationId={organizationId}
          order={selected}
          close={() => setSelected(null)}
        />
      )}
    </div>
  );
}
