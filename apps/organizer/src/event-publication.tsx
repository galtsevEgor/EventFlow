import { useMutation } from '@tanstack/react-query';
import { useRef } from 'react';
import { Badge, Button } from '@eventflow/ui';
import { api, queryClient, unwrap, type Schemas } from './api';
import { ErrorMessage } from './feedback';

export function EventPublication({
  id,
  event,
  canEdit,
  pendingCopy = false,
}: {
  id: string;
  event: Schemas['Draft'];
  canEdit: boolean;
  pendingCopy?: boolean;
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
  const retryKey = useRef<{ attempt: number; key: string } | null>(null);
  const retry = useMutation({
    mutationFn: async () => {
      if (!publication) throw new Error('Публикация не найдена.');
      if (retryKey.current?.attempt !== publication.attempt)
        retryKey.current = { attempt: publication.attempt, key: crypto.randomUUID() };
      return unwrap(
        await api.client.POST('/api/v1/organizations/{id}/events/{eventId}/publication/retry', {
          params: {
            path: { id, eventId: event.id },
            header: { 'Idempotency-Key': retryKey.current.key },
          },
          body: { expectedAttempt: publication.attempt },
        }),
      );
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['events', id] });
    },
  });
  const availability = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.client.PUT('/api/v1/organizations/{id}/events/{eventId}/availability', {
          params: { path: { id, eventId: event.id } },
          body: {
            paused: !publication?.desiredPaused,
            expectedVersion: publication?.commandVersion ?? 0,
          },
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['events', id] });
    },
  });
  const pending = publication && publication.commandVersion > publication.acknowledgedVersion;
  return (
    <div aria-live="polite">
      <Badge>
        {publication?.state === 'FAILED'
          ? 'Публикация отклонена'
          : publication?.state === 'PUBLISHED'
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
        <Button disabled={publish.isPending || pendingCopy} onClick={() => publish.mutate()}>
          Опубликовать
        </Button>
      )}
      {!publication && pendingCopy && (
        <p>Дождитесь сохранения правок в совместном редакторе перед публикацией.</p>
      )}
      <ErrorMessage error={publish.error} />
      {publication?.state === 'FAILED' && (
        <>
          <p>
            Не удалось подготовить продажу. Обратитесь к администратору; после устранения причины
            можно повторить публикацию.
          </p>
          {canEdit && (
            <Button disabled={retry.isPending} onClick={() => retry.mutate()}>
              Повторить публикацию
            </Button>
          )}
          <ErrorMessage error={retry.error} />
        </>
      )}
      {publication?.state === 'PUBLISHED' && (
        <>
          <p>
            {publication.acknowledgedPaused
              ? 'Продажи на паузе'
              : 'Продажи разрешены по расписанию'}
          </p>
          {pending && (
            <p role="status">
              {publication.desiredPaused
                ? 'Ожидаем подтверждение паузы…'
                : 'Ожидаем подтверждение возобновления…'}
            </p>
          )}
          {canEdit && (
            <Button
              variant="secondary"
              disabled={availability.isPending}
              onClick={() => availability.mutate()}
            >
              {publication.desiredPaused ? 'Возобновить продажи' : 'Приостановить продажи'}
            </Button>
          )}
          <ErrorMessage error={availability.error} />
        </>
      )}
    </div>
  );
}
