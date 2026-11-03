import Link from 'next/link';
import { createApiClient } from '@eventflow/api-client';
import { recommendationPageSchema, type RecommendationPage } from '@eventflow/event-contracts';
import { RecommendationCards } from './cards';

export async function similarEvents(id: string): Promise<RecommendationPage | null> {
  try {
    const client = createApiClient(process.env.BFF_URL ?? 'http://127.0.0.1:4000').client;
    const result = await client.GET('/api/v1/events/{id}/similar', {
      params: { path: { id }, query: { limit: 6 } },
      cache: 'no-store',
      signal: AbortSignal.timeout(1800),
    });
    if (result.response.status === 404) return null;
    if (!result.response.ok) throw new Error('Recommendations unavailable');
    return recommendationPageSchema.parse(result.data);
  } catch {
    return { items: [], mode: 'upcoming', degraded: true };
  }
}
export async function SimilarEvents({ id }: { id: string }) {
  const page = await similarEvents(id);
  if (!page) return null;
  return (
    <section aria-label="Рекомендации мероприятий" className="recommendations-section">
      <h2>{page.mode === 'similar' ? 'Похожие мероприятия' : 'Другие мероприятия'}</h2>
      {page.degraded && (
        <p className="muted">
          {page.items.length
            ? 'Пока показываем ближайшие события в этом городе.'
            : 'Подборка временно недоступна.'}
        </p>
      )}
      {page.items.length ? (
        <RecommendationCards items={page.items} />
      ) : (
        <p>
          Загляните в <Link href="/">каталог мероприятий</Link>.
        </p>
      )}
    </section>
  );
}
