import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Loading } from '@eventflow/ui';
import { formatPercent, formatUtcDateTime } from '@eventflow/ui/format';
import {
  analyticsReportSchema,
  analyticsPeriodSchema,
  type AnalyticsReportData,
} from '@eventflow/event-contracts';
import { api, unwrap } from './api';
import { eventListOptions } from './event-queries';
import { ErrorMessage } from './feedback';
import './product-analytics.css';

const day = (date: Date) => date.toISOString().slice(0, 10);
const labels = {
  impressions: 'Показы',
  views: 'Просмотры',
  held: 'Бронирования',
  confirmed: 'Покупки',
} as const;
type Metric = keyof typeof labels;
function Trend({ report }: { report: AnalyticsReportData }) {
  const [metric, setMetric] = useState<Metric>('confirmed'),
    [active, setActive] = useState<number | null>(null);
  const days =
    Math.round((Date.parse(report.period.to) - Date.parse(report.period.from)) / 86400000) + 1;
  const series = Array.from({ length: days }, (_, i) => {
    const date = day(new Date(Date.parse(report.period.from) + i * 86400000));
    const prev = day(new Date(Date.parse(report.previousPeriod.from) + i * 86400000));
    const value = (rows: AnalyticsReportData['current']['groups'], d: string) =>
      rows.filter((r) => r.date === d).reduce((n, r) => n + r[metric], 0);
    return {
      date,
      current: value(report.current.groups, date),
      previous: value(report.previous.groups, prev),
    };
  });
  const max = Math.max(1, ...series.flatMap((d) => [d.current, d.previous]));
  return (
    <figure className="product-trend">
      <figcaption>Динамика и предыдущий период</figcaption>
      <label>
        Показатель{' '}
        <select value={metric} onChange={(e) => setMetric(e.target.value as Metric)}>
          {Object.entries(labels).map(([key, label]) => (
            <option value={key} key={key}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <p>Синий — выбранный период; серый — предыдущий период той же длины.</p>
      <svg viewBox="0 0 620 180" role="img" aria-label={labels[metric] + ' по дням'}>
        {series.map((item, i) => (
          <g key={item.date} onMouseEnter={() => setActive(i)} onMouseLeave={() => setActive(null)}>
            <rect
              x={(i * 600) / days + 10}
              y={160 - (item.previous / max) * 140}
              width={Math.max(2, 270 / days)}
              height={(item.previous / max) * 140}
              fill="#a8adb8"
            />
            <rect
              x={(i * 600) / days + 10 + 280 / days}
              y={160 - (item.current / max) * 140}
              width={Math.max(2, 270 / days)}
              height={(item.current / max) * 140}
              fill="#3d59cf"
            />
            <title>{item.date + ': ' + item.current + '; предыдущий ' + item.previous}</title>
          </g>
        ))}
      </svg>
      <p aria-live="polite">
        {active === null
          ? 'Наведите на столбец или выберите дату в таблице.'
          : series[active]?.date +
            ': ' +
            series[active]?.current +
            '; предыдущий ' +
            series[active]?.previous}
      </p>
      <details>
        <summary>Данные графика</summary>
        <div className="sales-table-scroll">
          <table>
            <caption>{labels[metric] + ' по дням UTC'}</caption>
            <thead>
              <tr>
                <th>Дата</th>
                <th>Выбранный</th>
                <th>Предыдущий</th>
              </tr>
            </thead>
            <tbody>
              {series.map((d, i) => (
                <tr key={d.date}>
                  <th>
                    <button type="button" onFocus={() => setActive(i)} onClick={() => setActive(i)}>
                      {d.date}
                    </button>
                  </th>
                  <td>{d.current}</td>
                  <td>{d.previous}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
export function ProductAnalytics({ id }: { id: string }) {
  const [from, setFrom] = useState(() => day(new Date(Date.now() - 6 * 86400000))),
    [to, setTo] = useState(() => day(new Date()));
  const [eventId, setEventId] = useState(''),
    [source, setSource] = useState('');
  const query = { from, to, ...(eventId ? { eventId } : {}), ...(source ? { source } : {}) };
  const valid = analyticsPeriodSchema.safeParse(query);
  const events = useQuery(eventListOptions(id));
  const report = useQuery({
    queryKey: ['product-analytics', id, from, to, eventId, source],
    enabled: valid.success,
    queryFn: async () =>
      analyticsReportSchema.parse(
        unwrap(
          await api.client.GET('/api/v1/organizations/{id}/analytics', {
            params: {
              path: { id },
              query: {
                from,
                to,
                ...(eventId ? { eventId } : {}),
                ...(valid.success && valid.data.source ? { source: valid.data.source } : {}),
              },
            },
          }),
        ),
      ),
    refetchInterval: 10000,
  });
  const data = report.data;
  return (
    <section className="panel product-analytics">
      <h2>Продуктовая аналитика</h2>
      <p>
        Сессия браузера — до 24 часов. Воронка: первый показ карточки или прямое открытие → просмотр
        → бронь → подтверждённый заказ. Шаги идут по порядку в пределах 24 часов; покупка относится
        к тому же заказу. Все даты UTC.
      </p>
      <div className="product-filters">
        <label>
          С{' '}
          <input
            aria-label="Аналитика с"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label>
          По{' '}
          <input
            aria-label="Аналитика по"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <label>
          Мероприятие{' '}
          <select value={eventId} onChange={(e) => setEventId(e.target.value)}>
            <option value="">Все мероприятия</option>
            {events.data?.events.map((e) => (
              <option value={e.id} key={e.id}>
                {e.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Источник{' '}
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">Все источники</option>
            <option value="search">Поиск</option>
            <option value="catalog">Каталог</option>
            <option value="direct">Прямой переход</option>
          </select>
        </label>
      </div>
      {!valid.success && <p role="alert">Выберите корректный период до 31 дня.</p>}
      <ErrorMessage error={report.error} />
      {report.isError && (
        <Button onClick={() => void report.refetch()}>Повторить загрузку аналитики</Button>
      )}
      {report.isPending && valid.success && <Loading />}
      {data && valid.success && (
        <>
          <p role="status">
            {report.isError
              ? 'Не удалось обновить отчёт. Показаны последние загруженные данные.'
              : data.status.stale
                ? 'Обрабатываем новые события. Ожидает: ' + data.status.pending
                : 'Данные обновлены.'}{' '}
            Обновлено: {formatUtcDateTime(data.status.updatedAt)} UTC.
          </p>
          {data.current.impressions === 0 && (
            <p>
              В этом периоде пока нет показов. Это не означает отсутствия продаж: заказы без сессии
              не входят в воронку.
            </p>
          )}
          <p>
            Сравнение с {data.previousPeriod.from} — {data.previousPeriod.to}, UTC.
          </p>
          <dl className="product-kpis">
            {Object.entries(labels).map(([key, label]) => (
              <div key={key}>
                <dt>{label}</dt>
                <dd>
                  {data.current[key as Metric]} <small>ранее {data.previous[key as Metric]}</small>
                </dd>
              </div>
            ))}
            <div>
              <dt>Конверсия в покупку</dt>
              <dd>
                {formatPercent(data.current.conversion)}{' '}
                <small>ранее {formatPercent(data.previous.conversion)}</small>
              </dd>
            </div>
            <div>
              <dt>CTR поиска</dt>
              <dd>
                {formatPercent(data.current.ctr)} <small>клики / сессии с показом из поиска</small>
              </dd>
            </div>
          </dl>
          <Trend report={data} />
        </>
      )}
    </section>
  );
}
