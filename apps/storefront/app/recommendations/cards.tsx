import type { RecommendationPage } from '@eventflow/event-contracts';
import { EventCard } from '../event-card';

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
        <EventCard event={event} key={event.id} reason={reasons[reason]} />
      ))}
    </div>
  );
}
