import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, EmptyState, Field, Loading, Select } from '@eventflow/ui';
import { api, unwrap } from '../api';
import { ErrorMessage } from '../feedback';
import {
  caseUrl,
  formatDate,
  kindNames,
  sourceNames,
  stateName,
  type Kind,
  type Source,
} from './model';

export function OperatorList({ actor }: { actor: string }) {
  const initial = new URLSearchParams(location.search),
    [source, setSource] = useState<Source>(() =>
      ['catalog', 'tickets'].includes(initial.get('source') ?? '')
        ? (initial.get('source') as Source)
        : 'payments',
    ),
    [kind, setKind] = useState<Kind | ''>(''),
    [order, setOrder] = useState(''),
    [filter, setFilter] = useState({ kind: '' as Kind | '', orderId: '' }),
    [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1),
    query = {
      limit: 20,
      ...(filter.kind ? { kind: filter.kind } : {}),
      ...(filter.orderId ? { orderId: filter.orderId } : {}),
    };
  const overview = useQuery({
    queryKey: ['ops', actor, 'overview', filter],
    queryFn: async () => unwrap(await api.client.GET('/api/v1/ops/issues', { params: { query } })),
  });
  const page = useQuery({
    queryKey: ['ops', actor, 'page', source, filter, cursor],
    enabled: Boolean(cursor),
    queryFn: async () =>
      unwrap(
        await api.client.GET('/api/v1/ops/issues/{service}', {
          params: { path: { service: source }, query: { ...query, ...(cursor ? { cursor } : {}) } },
        }),
      ),
  });
  const selected = overview.data?.sources.find((item) => item.service === source),
    data = cursor ? page.data : selected;
  const refresh = () => {
    void overview.refetch();
    if (cursor) void page.refetch();
  };
  return (
    <section aria-label="Проблемы обработки">
      <div className="ops-heading">
        <h2>Проблемы обработки</h2>
        <Button
          variant="secondary"
          disabled={overview.isFetching || page.isFetching}
          onClick={refresh}
        >
          Обновить список
        </Button>
      </div>
      <div className="ops-sources">
        {(['payments', 'catalog', 'tickets'] as const).map((service) => {
          const status = overview.data?.sources.find((item) => item.service === service);
          return (
            <button
              key={service}
              type="button"
              className={`ops-source ${source === service ? 'ops-source--selected' : ''}`}
              aria-pressed={source === service}
              onClick={() => {
                setSource(service);
                setKind('');
                setFilter((current) => ({ ...current, kind: '' }));
                setCursors([]);
                history.replaceState(null, '', `/organizer/ops?source=${service}`);
              }}
            >
              <strong>{sourceNames[service]}</strong>
              <span>
                {!status
                  ? 'Проверяем…'
                  : !status.available
                    ? 'Источник недоступен'
                    : `Показано: ${status.items.length}${status.nextCursor ? '+' : ''}`}
              </span>
            </button>
          );
        })}
      </div>
      <form
        className="ops-filters"
        onSubmit={(event) => {
          event.preventDefault();
          setFilter({ kind, orderId: order.trim() });
          setCursors([]);
        }}
      >
        <Select
          label="Тип проблемы"
          value={kind}
          onChange={(event) => setKind(event.target.value as Kind | '')}
        >
          <option value="">Все типы</option>
          {(source === 'payments'
            ? (['payment', 'refund', 'webhook'] as const)
            : (['mail'] as const)
          ).map((value) => (
            <option key={value} value={value}>
              {kindNames[value]}
            </option>
          ))}
        </Select>
        <Field
          label="ID заказа"
          value={order}
          onChange={(event) => setOrder(event.target.value)}
          placeholder="Необязательный фильтр"
          pattern="[0-9a-fA-F-]{36}"
        />
        <Button type="submit">Применить фильтры</Button>
      </form>
      <ErrorMessage error={overview.error} />
      <ErrorMessage error={page.error} />
      {(overview.isPending || (cursor && page.isPending)) && <Loading />}
      {selected && !selected.available ? (
        <EmptyState title="Источник временно недоступен">
          Данные других сервисов остаются доступны. Повторите проверку позже.
        </EmptyState>
      ) : (
        data && (
          <>
            {data.items.length === 0 ? (
              <EmptyState title="Проблем по выбранным фильтрам нет">
                Нажмите «Обновить список», чтобы проверить снова.
              </EmptyState>
            ) : (
              <div className="ops-table-scroll">
                <table className="ops-table">
                  <caption className="muted">
                    {sourceNames[source]} · показаны записи, требующие внимания
                  </caption>
                  <thead>
                    <tr>
                      <th>Тип и запись</th>
                      <th>Состояние</th>
                      <th>Дата</th>
                      <th>Действие</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((item) => (
                      <tr key={item.kind + item.id}>
                        <td>
                          <strong>{kindNames[item.kind]}</strong>
                          <div className="ops-id">{item.id}</div>
                          {item.orderId && <small className="ops-id">Заказ {item.orderId}</small>}
                        </td>
                        <td>
                          <Badge>{stateName(item.state)}</Badge>
                          {item.code && <div className="muted">{item.code}</div>}
                        </td>
                        <td>
                          <time dateTime={item.recordedAt}>{formatDate(item.recordedAt)}</time>
                        </td>
                        <td>
                          <a href={caseUrl({ service: source, kind: item.kind, id: item.id })}>
                            Открыть
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="ops-pagination">
              <Button
                variant="secondary"
                disabled={cursors.length === 0 || page.isFetching}
                onClick={() => setCursors((current) => current.slice(0, -1))}
              >
                Назад
              </Button>
              <span>Страница {cursors.length + 1}</span>
              <Button
                variant="secondary"
                disabled={!data.nextCursor || page.isFetching}
                onClick={() => {
                  const next = data.nextCursor;
                  if (next) setCursors((current) => [...current, next]);
                }}
              >
                Далее
              </Button>
            </div>
          </>
        )
      )}
    </section>
  );
}
