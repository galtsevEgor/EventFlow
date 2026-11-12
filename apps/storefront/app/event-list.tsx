import Link from 'next/link';
import type { Schemas } from '@eventflow/api-client';
import { pageLink, type Search } from './catalog-api';
import { EventCard } from './event-card';

export function EventList({
  result,
  search,
  searchProof,
}: {
  result: Schemas['PublicEventPage'];
  search: Search;
  searchProof?: string | undefined;
}) {
  return (
    <div id="catalog" data-search-proof={searchProof}>
      <div className="results-heading">
        <h2>Ближайшие мероприятия</h2>
        <p>Найдено: {result.total}</p>
      </div>
      {result.events.length === 0 ? (
        <div className="empty">
          <h2>{result.total ? 'На этой странице нет мероприятий' : 'Мероприятий не найдено'}</h2>
          <p>Попробуйте изменить фильтры или загляните позже.</p>
          <Link href="/">Сбросить фильтры</Link>
        </div>
      ) : (
        <div className="public-event-grid">
          {result.events.map((event) => (
            <EventCard event={event} key={event.id} analytics />
          ))}
        </div>
      )}
      {result.pages > 1 && (
        <nav className="pagination" aria-label="Страницы каталога">
          {result.page > 1 && <Link href={pageLink(search, result.page - 1)}>← Предыдущая</Link>}
          <span aria-current="page">
            Страница {result.page} из {result.pages}
          </span>
          {result.page < result.pages && (
            <Link href={pageLink(search, result.page + 1)}>Следующая →</Link>
          )}
        </nav>
      )}
    </div>
  );
}
