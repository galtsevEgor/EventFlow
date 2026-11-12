import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteHeader } from '../../site-header';
import { getEvent } from '../../catalog-api';
import { formatEventDateTime, formatPrice } from '../../format';
import { SalePanel } from '../../sale-panel';
import { Suspense } from 'react';
import { SimilarEvents } from '../../recommendations/similar';
import { FavoriteButton } from '../../recommendations/favorite';
import './event-page.css';

export const dynamic = 'force-dynamic';
type Props = { params: Promise<{ id: string }> };
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const event = await getEvent((await params).id);
  return {
    title: `${event.title} — EventFlow`,
    description: event.description.slice(0, 160),
    alternates: { canonical: `/events/${event.id}` },
    openGraph: {
      title: event.title,
      description: event.description.slice(0, 160),
      type: 'website',
      ...(event.coverId ? { images: [`/api/v1/covers/${event.coverId}`] } : {}),
    },
  };
}
export default async function EventPage({ params }: Props) {
  const event = await getEvent((await params).id);
  const origin = process.env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:18000';
  const structured = {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: event.title,
    description: event.description,
    startDate: event.startsAt,
    endDate: event.endsAt,
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    eventStatus: 'https://schema.org/EventScheduled',
    location: {
      '@type': 'Place',
      name: event.address,
      address: {
        '@type': 'PostalAddress',
        addressLocality: event.city,
        streetAddress: event.address,
      },
    },
    ...(event.coverId ? { image: new URL(`/api/v1/covers/${event.coverId}`, origin).href } : {}),
    url: new URL(`/events/${event.id}`, origin).href,
  };
  return (
    <main className="storefront-page event-page">
      <SiteHeader returnTo={`/events/${event.id}`} />
      <div className="page-breadcrumb">
        <Link href="/" className="back-link">
          ← Все мероприятия
        </Link>
      </div>
      <section className="event-hero" aria-labelledby="event-title">
        <div className="event-hero-copy">
          <p className="event-hero-location">{event.city}</p>
          <h1 id="event-title">{event.title}</h1>
          <dl className="event-info">
            <div>
              <dt>Дата и время</dt>
              <dd>
                <time dateTime={event.startsAt}>
                  {formatEventDateTime(event.startsAt, event.timeZone)}
                </time>
              </dd>
            </div>
            <div>
              <dt>Адрес</dt>
              <dd>{event.address}</dd>
            </div>
          </dl>
          <div className="event-hero-actions">
            <a className="site-action" href="#tickets">
              К билетам <span aria-hidden="true">↓</span>
            </a>
            <p>
              от <strong>{formatPrice(event.minPriceMinor)}</strong>
            </p>
          </div>
        </div>
        {event.coverId && (
          <div className="event-hero-art">
            <img
              className="detail-cover"
              src={`/api/v1/covers/${event.coverId}`}
              alt={`Афиша: ${event.title}`}
              width={1000}
              height={700}
              fetchPriority="high"
            />
          </div>
        )}
      </section>
      <div className="event-content">
        <section className="event-ticket-panel" aria-labelledby="tickets">
          <h2 id="tickets" tabIndex={-1}>
            Билеты и места
          </h2>
          <SalePanel id={event.id} timeZone={event.timeZone} />
        </section>
        <section className="event-about-panel" aria-labelledby="about-event">
          <h2 id="about-event">О мероприятии</h2>
          <p className="event-description">{event.description}</p>
          <p className="muted">Часовой пояс: {event.timeZone}</p>
          <FavoriteButton id={event.id} />
        </section>
      </div>
      <Suspense
        fallback={
          <section className="recommendations-section" aria-busy="true">
            <h2>Подбираем мероприятия…</h2>
          </section>
        }
      >
        <SimilarEvents id={event.id} />
      </Suspense>
      <footer className="site-footer">EventFlow</footer>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structured).replace(/</g, '\\u003c') }}
      />
    </main>
  );
}
