import Link from 'next/link';
import type { Schemas } from '@eventflow/api-client';
import { formatEventDateTime, formatPrice } from './format';

export function EventCard({
  event,
  reason,
  analytics = false,
}: {
  event: Schemas['PublicEvent'];
  reason?: string;
  analytics?: boolean;
}) {
  return (
    <article
      className="public-event-card"
      aria-label={event.title}
      data-analytics-event={analytics ? event.id : undefined}
    >
      <Link href={'/events/' + event.id} className="event-link">
        <div className="event-card-art">
          {event.coverId && (
            <img
              src={'/api/v1/covers/' + event.coverId}
              alt={'Афиша: ' + event.title}
              loading="lazy"
              width={640}
              height={400}
            />
          )}
        </div>
        <div className="card-content">
          {reason && <p className="recommendation-reason">{reason}</p>}
          <p className="event-city">{event.city}</p>
          <h3>{event.title}</h3>
          <time dateTime={event.startsAt}>
            {formatEventDateTime(event.startsAt, event.timeZone)}
          </time>
          <p className="event-price">от {formatPrice(event.minPriceMinor)}</p>
        </div>
      </Link>
    </article>
  );
}
