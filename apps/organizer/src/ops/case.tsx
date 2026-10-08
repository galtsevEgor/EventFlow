import { useCallback, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Loading } from '@eventflow/ui';
import { api, unwrap } from '../api';
import { ErrorMessage } from '../feedback';
import {
  formatDate,
  formatMoney,
  isWorking,
  kindNames,
  sourceNames,
  stateName,
  type Target,
} from './model';
import { RecoveryControl } from './recovery';
import { readPending, recoveryKey } from './pending';

export function OperatorCase({
  actor,
  target,
  canRecover,
}: {
  actor: string;
  target: Target;
  canRecover: boolean;
}) {
  const [pollUntil, setPollUntil] = useState(() => Date.now() + 120000),
    button = useRef<HTMLButtonElement>(null);
  const detail = useQuery({
    queryKey: ['ops', actor, 'case', target.service, target.kind, target.id],
    queryFn: async () =>
      unwrap(
        await api.client.GET('/api/v1/ops/issues/{service}/{kind}/{id}', {
          params: { path: target },
        }),
      ),
    refetchInterval: (query) =>
      query.state.data &&
      (isWorking(query.state.data.issue.state) || readPending(recoveryKey(actor, target))) &&
      Date.now() < pollUntil
        ? 3000
        : false,
  });
  const refetch = detail.refetch;
  const refresh = useCallback(
    (focus = false) => {
      setPollUntil(Date.now() + 120000);
      void refetch();
      if (focus) requestAnimationFrame(() => button.current?.focus());
    },
    [refetch],
  );
  const data = detail.data;
  return (
    <section className="panel ops-case" aria-label="Карточка расследования">
      <a href={`/organizer/ops?source=${target.service}`}>← К списку проблем</a>
      <div className="ops-heading">
        <div>
          <p className="muted">{sourceNames[target.service]}</p>
          <h2>{kindNames[target.kind]}</h2>
          <p className="ops-id">{target.id}</p>
        </div>
        <Button
          ref={button}
          variant="secondary"
          disabled={detail.isFetching}
          onClick={() => refresh()}
        >
          Обновить статус
        </Button>
      </div>
      <ErrorMessage error={detail.error} />
      {detail.isPending && <Loading />}
      {data && (
        <>
          <Badge>{stateName(data.issue.state)}</Badge>
          {detail.isError && <p className="muted">Показаны последние полученные данные.</p>}
          <dl className="ops-facts">
            <div>
              <dt>Дата записи</dt>
              <dd>{formatDate(data.issue.recordedAt)}</dd>
            </div>
            <div>
              <dt>Попытки обработки</dt>
              <dd>{data.facts.attempts}</dd>
            </div>
            {data.facts.amountMinor !== undefined && (
              <div>
                <dt>Сумма операции</dt>
                <dd>{formatMoney(data.facts.amountMinor, data.facts.currency)}</dd>
              </div>
            )}
            {data.issue.code && (
              <div>
                <dt>Код причины</dt>
                <dd>{data.issue.code}</dd>
              </div>
            )}
            {data.facts.bookingState && (
              <div>
                <dt>Состояние связи с заказом</dt>
                <dd>{stateName(data.facts.bookingState)}</dd>
              </div>
            )}
            {data.facts.nextRunAt && isWorking(data.issue.state) && (
              <div>
                <dt>План обработки</dt>
                <dd>{formatDate(data.facts.nextRunAt)}</dd>
              </div>
            )}
          </dl>
          {data.issue.orderId && (
            <section aria-label="Связанный заказ">
              <h3>Связанный заказ</h3>
              <p className="ops-id">{data.issue.orderId}</p>
              {data.orderStatus === 'available' && data.order ? (
                <p>
                  {stateName(data.order.state)} · {data.order.seatCount} мест ·{' '}
                  {formatMoney(data.order.totalMinor, data.order.currency)}
                </p>
              ) : (
                <p role="status">
                  {data.orderStatus === 'missing'
                    ? 'Заказ не найден в Booking.'
                    : 'Booking временно недоступен. Статус заказа не подтверждён.'}
                </p>
              )}
            </section>
          )}
          <section aria-label="Диагностика">
            <h3>Диагностика</h3>
            {data.traceUrl ? (
              <a href={data.traceUrl} target="_blank" rel="noreferrer">
                Открыть трассу
              </a>
            ) : (
              <p>Трасса для этой записи не сохранена.</p>
            )}
            <p className="muted">
              Доступность трассы зависит от выборки и срока хранения. Журнал действий хранится
              отдельно.
            </p>
          </section>
          {canRecover ? (
            <RecoveryControl actor={actor} target={target} detail={data} refresh={refresh} />
          ) : (
            <p className="muted">Режим просмотра. Запуск восстановления недоступен.</p>
          )}
          {isWorking(data.issue.state) && Date.now() >= pollUntil && (
            <p role="status">Обработка продолжается. Обновите статус вручную.</p>
          )}
          <section aria-label="Журнал действий">
            <h3>Журнал действий</h3>
            {data.actions.length === 0 ? (
              <p>Ручных действий пока нет.</p>
            ) : (
              <ol className="ops-audit">
                {data.actions.map((action) => (
                  <li key={action.key}>
                    <strong>
                      {action.actorType === 'HUMAN' ? 'Оператор' : 'Служебная операция'}
                    </strong>{' '}
                    · <time dateTime={action.createdAt}>{formatDate(action.createdAt)}</time>
                    <p className="ops-id">Учётная запись: {action.actor}</p>
                    {action.reason && <p>{action.reason}</p>}
                    <small className="ops-id">{action.key}</small>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </section>
  );
}
