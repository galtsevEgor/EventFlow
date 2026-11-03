'use client';
import { useMutation, useQuery } from '@tanstack/react-query';
import { unwrap } from '@eventflow/api-client';
import { recommendationProfileSchema } from '@eventflow/event-contracts';
import { Alert, Button } from '@eventflow/ui';
import { BookingProvider, useBuyer } from '../booking/client';

function Favorite({ id, actor }: { id: string; actor: string }) {
  const { api } = useBuyer();
  const profile = useQuery({
    queryKey: ['recommendation-profile', actor],
    queryFn: async ({ signal }) =>
      recommendationProfileSchema.parse(
        unwrap(await api.client.GET('/api/v1/recommendations/profile', { signal })),
      ),
  });
  const saved = profile.data?.favorites.some((item) => item.eventId === id) ?? false;
  const mutation = useMutation({
    mutationFn: async () => {
      const result = saved
        ? await api.client.DELETE('/api/v1/recommendations/favorites/{id}', {
            params: { path: { id } },
          })
        : await api.client.PUT('/api/v1/recommendations/favorites/{id}', {
            params: { path: { id } },
          });
      return recommendationProfileSchema.parse(unwrap(result));
    },
    onSuccess: () => {
      void profile.refetch();
    },
  });
  return (
    <div className="favorite-control">
      <Button
        variant="secondary"
        aria-pressed={saved}
        disabled={!profile.data || mutation.isPending || profile.isFetching}
        onClick={() => mutation.mutate()}
      >
        {saved ? 'Убрать из избранного' : 'В избранное'}
      </Button>
      {profile.isError && (
        <Button variant="secondary" onClick={() => void profile.refetch()}>
          Повторить загрузку избранного
        </Button>
      )}
      {mutation.isError && <Alert>Не удалось сохранить. Повторите запрос.</Alert>}
    </div>
  );
}
function Gate({ id }: { id: string }) {
  const { session } = useBuyer();
  return session.data?.user?.emailVerified ? (
    <Favorite key={session.data.user.sub} id={id} actor={session.data.user.sub} />
  ) : null;
}
export function FavoriteButton({ id }: { id: string }) {
  return (
    <BookingProvider>
      <Gate id={id} />
    </BookingProvider>
  );
}
