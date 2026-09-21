import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, EmptyState, Loading } from '@eventflow/ui';
import { api, unwrap, type Schemas } from './api';
import { ErrorMessage } from './feedback';

const euro = new Intl.NumberFormat('ru', { style: 'currency', currency: 'EUR' });
const money = (minor: number) => euro.format(minor / 100);
const instant = new Intl.DateTimeFormat('ru', {
  dateStyle: 'short',
  timeStyle: 'medium',
  timeZone: 'UTC',
});
type Report = Schemas['SalesStatistics'];

function SalesChart({ series }: Pick<Report, 'series'>) {
  const maximum = Math.max(...series.map((day) => day.revenueMinor));
  return (
    <figure className="sales-chart">
      <figcaption>Подтверждённые продажи по дням, UTC</figcaption>
      {maximum === 0 ? (
        <p>В этом периоде нет подтверждённых продаж.</p>
      ) : (
        <svg viewBox="0 0 600 150" role="img" aria-label="Сумма подтверждённых продаж по дням">
          {series.map((day, index) => {
            const height = (130 * day.revenueMinor) / maximum;
            return (
              <rect
                key={day.date}
                x={(index * 600) / series.length}
                y={140 - height}
                width={Math.max(1, 600 / series.length - 1)}
                height={height}
                fill="currentColor"
              >
                <title>
                  {day.date} · {money(day.revenueMinor)} · заказов {day.confirmedOrders}
                </title>
              </rect>
            );
          })}
        </svg>
      )}
      <details>
        <summary>Данные графика</summary>
        <div className="sales-table-scroll">
          <table>
            <caption>Подтверждённые продажи по дням</caption>
            <thead>
              <tr>
                <th scope="col">Дата UTC</th>
                <th scope="col">Заказы</th>
                <th scope="col">Сумма</th>
              </tr>
            </thead>
            <tbody>
              {series.map((day) => (
                <tr key={day.date}>
                  <th scope="row">{day.date}</th>
                  <td>{day.confirmedOrders}</td>
                  <td>{money(day.revenueMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

export function SalesStatistics({ id }: { id: string }) {
  const [draft, setDraft] = useState({ from: '', to: '', eventId: '' });
  const [filters, setFilters] = useState({ ...draft, page: 1 });
  const events = useQuery({
    queryKey: ['events', id],
    queryFn: async () =>
      unwrap(
        await api.client.GET('/api/v1/organizations/{id}/events', {
          params: { path: { id } },
        }),
      ),
  });
  const report = useQuery({
    queryKey: ['sales-statistics', id, filters],
    refetchInterval: 30000,
    queryFn: async () =>
      unwrap(
        await api.client.GET('/api/v1/organizations/{id}/statistics', {
          params: {
            path: { id },
            query: {
              ...(filters.from ? { from: filters.from } : {}),
              ...(filters.to ? { to: filters.to } : {}),
              ...(filters.eventId ? { eventId: filters.eventId } : {}),
              page: filters.page,
            },
          },
        }),
      ),
  });
  const data = report.data;
  const cards = data
    ? [
        ['Подтверждённые заказы', data.totals.confirmedOrders],
        ['Продано мест за всё время', data.totals.soldSeats],
        ['Мест в действующих бронях', data.totals.heldSeats],
        ['Доступно мест', data.totals.availableSeats],
        ['Подтверждённые продажи', money(data.totals.revenueMinor)],
        ['Получено оплат', money(data.totals.paidMinor)],
        ['Завершённые возвраты', money(data.totals.refundedMinor)],
        ['Оплаты за вычетом возвратов', money(data.totals.netMinor)],
      ]
    : [];
  return (
    <section aria-labelledby="sales-heading" aria-busy={report.isFetching}>
      <div className="section-heading sales-heading">
        <h2 id="sales-heading">Статистика продаж</h2>
        <Button
          variant="secondary"
          disabled={report.isFetching}
          onClick={() => void report.refetch()}
        >
          Обновить статистику
        </Button>
      </div>
      <form
        className="sales-filters"
        aria-label="Фильтры статистики"
        onSubmit={(event) => {
          event.preventDefault();
          setFilters({ ...draft, page: 1 });
        }}
      >
        <label>
          Мероприятие
          <select
            aria-label="Мероприятие"
            value={draft.eventId}
            onChange={(event) => setDraft({ ...draft, eventId: event.target.value })}
          >
            <option value="">Все мероприятия</option>
            {events.data?.events
              .filter((event) => event.publication?.state === 'PUBLISHED')
              .map((event) => (
                <option key={event.id} value={event.id}>
                  {event.title}
                </option>
              ))}
          </select>
        </label>
        <label>
          С даты, UTC
          <input
            type="date"
            value={draft.from}
            onChange={(event) => setDraft({ ...draft, from: event.target.value })}
          />
        </label>
        <label>
          По дату, UTC
          <input
            type="date"
            value={draft.to}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
          />
        </label>
        <Button type="submit" disabled={report.isFetching}>
          Применить фильтры
        </Button>
      </form>
      <p className="muted">Период до 366 дней. Без дат отображаются последние 30 дней UTC.</p>
      <ErrorMessage error={report.error ?? events.error} />
      {report.isPending ? (
        <Loading />
      ) : (
        data &&
        !report.error && (
          <>
            <p>
              Период {data.from} — {data.to}, UTC.
            </p>
            <p className="muted">
              Суммы учитываются по дате подтверждения, оплаты и завершения возврата. Снимок мест
              включает всё время и обновляется по мере поступления событий.
            </p>
            <p className="muted">
              События обработаны{' '}
              {data.lastUpdatedAt
                ? instant.format(new Date(data.lastUpdatedAt)) + ' UTC'
                : '— ожидаются данные'}
              . Отчёт сформирован {instant.format(new Date(data.asOf))} UTC.
            </p>
            <dl className="sales-metrics">
              {cards.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <SalesChart series={data.series} />
            {data.total === 0 ? (
              <EmptyState title="Опубликованных мероприятий пока нет">
                Статистика появится после публикации мероприятия.
              </EmptyState>
            ) : (
              <div
                className="sales-table-scroll"
                tabIndex={0}
                role="region"
                aria-label="Таблица статистики мероприятий"
              >
                <table>
                  <caption>Статистика мероприятий</caption>
                  <thead>
                    <tr>
                      <th scope="col">Мероприятие</th>
                      <th scope="col">Продано мест</th>
                      <th scope="col">В бронях</th>
                      <th scope="col">Доступно</th>
                      <th scope="col">Заказы за период</th>
                      <th scope="col">Продажи</th>
                      <th scope="col">Оплаты</th>
                      <th scope="col">Возвраты</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.events.map((event) => (
                      <tr key={event.id}>
                        <th scope="row">{event.title}</th>
                        <td>{event.soldSeats}</td>
                        <td>{event.heldSeats}</td>
                        <td>{event.availableSeats}</td>
                        <td>{event.confirmedOrders}</td>
                        <td>{money(event.revenueMinor)}</td>
                        <td>{money(event.paidMinor)}</td>
                        <td>{money(event.refundedMinor)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {data.pages > 1 && (
              <nav className="section-heading" aria-label="Страницы статистики">
                <Button
                  variant="secondary"
                  disabled={data.page === 1 || report.isFetching}
                  onClick={() => setFilters({ ...filters, page: data.page - 1 })}
                >
                  Предыдущая
                </Button>
                <span>
                  Страница {data.page} из {data.pages}
                </span>
                <Button
                  variant="secondary"
                  disabled={data.page >= data.pages || report.isFetching}
                  onClick={() => setFilters({ ...filters, page: data.page + 1 })}
                >
                  Следующая
                </Button>
              </nav>
            )}
          </>
        )
      )}
    </section>
  );
}
