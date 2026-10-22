import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { searchAnalyticsSchema } from '@eventflow/event-contracts';
import { api, unwrap } from './api';
import { ErrorMessage } from './feedback';
export function SearchQuality() {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const result = useQuery({
    queryKey: ['search-quality', date],
    enabled: !!date,
    queryFn: async () =>
      searchAnalyticsSchema.parse(
        unwrap(
          await api.client.GET('/api/v1/analytics/search-quality', {
            params: { query: { from: date, to: date } },
          }),
        ),
      ),
  });
  return (
    <section className="panel">
      <h2>Качество поиска</h2>
      <label>
        Дата UTC <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <p>
        Успешные запросы выдачи через BFF, включая SSR. Подсказки не учитываются. Сбор при
        недоступности аналитики может быть неполным; текст запросов не сохраняется.
      </p>
      <ErrorMessage error={result.error} />
      {result.data && (
        <p>
          Запросов: {result.data.searches}; без результатов: {result.data.empty}; доля пустых:{' '}
          {result.data.emptyRate === null ? '—' : (result.data.emptyRate * 100).toFixed(1) + '%'};
          через резервный каталог: {result.data.limited}.{' '}
          {result.data.status.stale ? 'Проекция догоняет журнал.' : 'Проекция актуальна.'}
        </p>
      )}
    </section>
  );
}
