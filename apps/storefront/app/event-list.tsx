import Link from 'next/link';
import type { Schemas } from '@eventflow/api-client';
import { pageLink, type Search } from './catalog-api';
import { formatDate, formatPrice } from './format';

export function EventList({
  result,
  search,
}: {
  result: Schemas['PublicEventPage'];
  search: Search;
}) {
  return (
    <div id="catalog">
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
            <article className="public-event-card" key={event.id}>
              <Link href={`/events/${event.id}`} className="event-link">
                {event.coverId && (
                  <img
                    src={`/api/v1/covers/${event.coverId}`}
                    alt={`Афиша: ${event.title}`}
                    loading="lazy"
                    width={640}
                    height={400}
                  />
                )}
                <div className="card-content">
                  <p className="event-city">{event.city}</p>
                  <h3>{event.title}</h3>
                  <time dateTime={event.startsAt}>
                    {formatDate(event.startsAt, event.timeZone)}
                  </time>
                  <p className="event-price">от {formatPrice(event.minPriceMinor)}</p>
                </div>
              </Link>
            </article>
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
