import { useMutation } from '@tanstack/react-query';
import { Badge, Button } from '@eventflow/ui';
import { api, queryClient, unwrap, type Schemas } from './api';
import { ErrorMessage } from './feedback';

export function EventPublication({
  id,
  event,
  canEdit,
}: {
  id: string;
  event: Schemas['Draft'];
  canEdit: boolean;
}) {
  const publish = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.client.POST('/api/v1/organizations/{id}/events/{eventId}/publication', {
          params: { path: { id, eventId: event.id } },
          body: { revision: event.revision },
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['events', id] });
    },
  });
  const publication = event.publication;
  return (
    <div aria-live="polite">
      <Badge>
        {publication?.state === 'PUBLISHED'
          ? 'Опубликовано'
          : publication
            ? 'Готовится к публикации'
            : 'Черновик'}
      </Badge>
      {publication?.state === 'PROVISIONING' && (
        <p className="muted">
          Подготавливаем места для продажи. Событие появится в каталоге после подтверждения;
          страницу можно закрыть.
        </p>
      )}
      {!publication && canEdit && (
        <Button disabled={publish.isPending} onClick={() => publish.mutate()}>
          Опубликовать
        </Button>
      )}
      <ErrorMessage error={publish.error} />
    </div>
  );
}
