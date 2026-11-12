'use client';

import Link from 'next/link';
import { useRef, useState } from 'react';
import type { Schemas } from '@eventflow/api-client';
import { formatEventDateTime, formatPrice } from './format';

export function FeaturedEvents({
  events,
  searchProof,
}: {
  events: Schemas['PublicEventPage']['events'];
  searchProof: string | undefined;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(0);

  function goTo(index: number) {
    const element = track.current;
    if (element && index >= 0 && index < events.length)
      element.scrollTo({ left: index * element.clientWidth });
  }

  return (
    <section
      className="featured-events"
      aria-label="Ближайшие события"
      data-search-proof={searchProof}
    >
      <div
        className="featured-track"
        ref={track}
        onScroll={(event) => {
          const { scrollLeft, clientWidth } = event.currentTarget;
          if (clientWidth) setCurrent(Math.round(scrollLeft / clientWidth));
        }}
      >
        {events.map((event, index) => (
          <article className="featured-slide" key={event.id} data-analytics-event={event.id}>
            <Link href={'/events/' + event.id} className="featured-link">
              <div className="featured-art">
                {event.coverId && (
                  <img
                    src={'/api/v1/covers/' + event.coverId}
                    alt=""
                    width={640}
                    height={360}
                    loading={index === 0 ? 'eager' : 'lazy'}
                  />
                )}
              </div>
              <div className="featured-caption">
                <p>
                  {event.city} ·{' '}
                  <time dateTime={event.startsAt}>
                    {formatEventDateTime(event.startsAt, event.timeZone)}
                  </time>
                </p>
                <h2>{event.title}</h2>
                <strong>от {formatPrice(event.minPriceMinor)}</strong>
              </div>
              <span className="featured-link-arrow" aria-hidden="true">
                ↗
              </span>
            </Link>
          </article>
        ))}
      </div>
      {events.length > 1 && (
        <nav className="featured-controls" aria-label="Переключение событий">
          <span aria-live="polite">
            {current + 1} из {events.length}
          </span>
          <button
            type="button"
            aria-label="Предыдущее событие"
            aria-disabled={current === 0}
            onClick={() => goTo(current - 1)}
          >
            <span aria-hidden="true">←</span>
          </button>
          <button
            type="button"
            aria-label="Следующее событие"
            aria-disabled={current === events.length - 1}
            onClick={() => goTo(current + 1)}
          >
            <span aria-hidden="true">→</span>
          </button>
        </nav>
      )}
    </section>
  );
}
