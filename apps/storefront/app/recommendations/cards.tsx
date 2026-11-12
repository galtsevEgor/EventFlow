import Link from 'next/link';
import type { RecommendationPage } from '@eventflow/event-contracts';
import { formatEventDateTime, formatPrice } from '../format';

const reasons = {
  SIMILAR: 'Похоже на это мероприятие',
  INTERESTS: 'По вашим интересам',
  FAVORITES: 'С учётом избранного',
  UPCOMING: 'Ближайшее мероприятие',
};
export function RecommendationCards({ items }: { items: RecommendationPage['items'] }) {
  return (
    <div className="public-event-grid">
      {items.map(({ event, reason }) => (
        <article className="public-event-card" aria-label={event.title} key={event.id}>
          <Link href={'/events/' + event.id} className="event-link">
            {event.coverId && (
              <img
                src={'/api/v1/covers/' + event.coverId}
                alt={'Афиша: ' + event.title}
                loading="lazy"
                width={640}
                height={400}
              />
            )}
            <div className="card-content">
              <p className="recommendation-reason">{reasons[reason]}</p>
              <p className="event-city">{event.city}</p>
              <h3>{event.title}</h3>
              <time dateTime={event.startsAt}>
                {formatEventDateTime(event.startsAt, event.timeZone)}
              </time>
              <p className="event-price">от {formatPrice(event.minPriceMinor)}</p>
            </div>
          </Link>
        </article>
      ))}
    </div>
  );
}
