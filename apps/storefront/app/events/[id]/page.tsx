import type { Metadata } from 'next';
import Link from 'next/link';
import { Account } from '../../account';
import { getEvent } from '../../catalog-api';
import { formatDate } from '../../format';
import { SalePanel } from '../../sale-panel';

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
    <main>
      <Link className="brand" href="/">
        EventFlow<span aria-hidden="true">↗</span>
      </Link>
      <Account />
      <section className="event-detail">
        <Link href="/" className="back-link">
          ← Все мероприятия
        </Link>
        <p className="eyebrow">
          {event.city} · {event.capacity} мест
        </p>
        <h1>{event.title}</h1>
        <div className="detail-grid">
          <div>
            {event.coverId && (
              <img
                className="detail-cover"
                src={`/api/v1/covers/${event.coverId}`}
                alt={`Афиша: ${event.title}`}
                width={1000}
                height={700}
              />
            )}
            <h2>О мероприятии</h2>
            <p className="event-description">{event.description}</p>
          </div>
          <aside className="event-info" aria-label="Время, место и билеты">
            <h2>Когда и где</h2>
            <p>
              <time dateTime={event.startsAt}>{formatDate(event.startsAt, event.timeZone)}</time>
            </p>
            <p className="muted">Часовой пояс: {event.timeZone}</p>
            <p>
              {event.city}, {event.address}
            </p>
            <h2>Билеты</h2>
            <SalePanel id={event.id} timeZone={event.timeZone} />
          </aside>
        </div>
      </section>
      <footer>EventFlow · События, которые объединяют</footer>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(structured).replace(/</g, '\\u003c') }}
      />
    </main>
  );
}
