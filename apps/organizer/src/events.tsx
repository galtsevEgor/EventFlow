import { lazy, Suspense, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button, Dialog, EmptyState, Field, Loading } from '@eventflow/ui';
import { api, queryClient, unwrap, type Schemas } from './api';
import { ErrorMessage } from './feedback';
import { EventCover } from './event-cover';
import { EventPublication } from './event-publication';
import { hasPendingCopy } from './collaboration/cache';
const CollaborativeEditor = lazy(() =>
  import('./collaboration/editor').then((module) => ({ default: module.CollaborativeEditor })),
);
const EventConfiguration = lazy(() =>
  import('./event-configuration').then((module) => ({ default: module.EventConfiguration })),
);
const CheckIn = lazy(() => import('./check-in').then(({ CheckIn }) => ({ default: CheckIn })));

const input = z.object({
  title: z.string().trim().min(2, 'Минимум 2 символа').max(160, 'Максимум 160 символов'),
  description: z.string().trim().max(5000),
});
export function Events({ id, role }: { id: string; role: Schemas['Role'] }) {
  const subject = queryClient.getQueryData<Schemas['Session']>(['session'])?.user?.sub ?? '';
  const [collaborating, setCollaborating] = useState<Schemas['Draft'] | null>(null);
  const events = useQuery({
    queryKey: ['events', id],
    refetchInterval: (query) =>
      query.state.data?.events.some(
        (event) =>
          event.publication?.state === 'PROVISIONING' ||
          (!!event.publication &&
            event.publication.commandVersion > event.publication.acknowledgedVersion),
      )
        ? 1000
        : false,
    queryFn: async () =>
      unwrap(
        await api.client.GET('/api/v1/organizations/{id}/events', { params: { path: { id } } }),
      ),
  });
  const [editing, setEditing] = useState<Schemas['Draft'] | 'new' | null>(null);
  const [configuring, setConfiguring] = useState<Schemas['Draft'] | null>(null);
  const [cover, setCover] = useState<Schemas['Draft'] | null>(null);
  const [admission, setAdmission] = useState<Schemas['Draft'] | null>(null);
  const form = useForm({
    resolver: zodResolver(input),
    defaultValues: { title: '', description: '' },
  });
  const save = useMutation({
    mutationFn: async (body: z.infer<typeof input>) =>
      editing && editing !== 'new'
        ? unwrap(
            await api.client.PATCH('/api/v1/organizations/{id}/events/{eventId}', {
              params: { path: { id, eventId: editing.id } },
              body,
            }),
          )
        : unwrap(
            await api.client.POST('/api/v1/organizations/{id}/events', {
              params: { path: { id } },
              body,
            }),
          ),
    onSuccess: async () => {
      setEditing(null);
      await queryClient.invalidateQueries({ queryKey: ['events', id] });
    },
  });
  const canEdit = role !== 'STAFF';
  function edit(draft: Schemas['Draft'] | 'new') {
    save.reset();
    form.reset(draft === 'new' ? { title: '', description: '' } : draft);
    setEditing(draft);
  }
  return (
    <>
      <div className="section-heading">
        <div>
          <h3>Мероприятия</h3>
          <p className="muted">
            {canEdit
              ? 'Сохраните идею вашего следующего события.'
              : 'Вам доступны только назначенные мероприятия.'}
          </p>
        </div>
        {canEdit && <Button onClick={() => edit('new')}>Новое мероприятие</Button>}
      </div>
      <ErrorMessage error={events.error} />
      {events.isPending && <Loading />}
      {events.data?.events.length === 0 && (
        <EmptyState title="Пока нет мероприятий">
          {canEdit
            ? 'Создайте первый черновик: добавьте название и описание.'
            : 'Попросите владельца назначить вам мероприятие.'}
        </EmptyState>
      )}
      <div className="event-grid">
        {events.data?.events.map((event) => (
          <article className="event-card" key={event.id}>
            {event.coverId && (
              <img
                className="cover-preview"
                loading="lazy"
                src={`/api/v1/organizations/${id}/events/${event.id}/cover?v=${event.coverId}`}
                alt={`Афиша: ${event.title}`}
              />
            )}
            <EventPublication
              id={id}
              event={event}
              canEdit={canEdit}
              pendingCopy={hasPendingCopy(subject, id, event.id)}
            />
            <h3>{event.title}</h3>
            <p>{event.description || 'Описание ещё не добавлено.'}</p>
            {!event.publication && (
              <Button variant="secondary" onClick={() => setCollaborating(event)}>
                Совместный редактор
              </Button>
            )}
            {event.publication?.state === 'PUBLISHED' && (
              <Button variant="secondary" onClick={() => setAdmission(event)}>
                Контроль входа
              </Button>
            )}
            {canEdit && (
              <Button variant="secondary" onClick={() => setCover(event)}>
                Афиша
              </Button>
            )}
            {canEdit && (
              <Button
                variant="secondary"
                disabled={!!event.publication}
                onClick={() => setConfiguring(event)}
              >
                Настроить продажи
              </Button>
            )}
            {canEdit && (
              <Button variant="secondary" onClick={() => edit(event)}>
                Редактировать
              </Button>
            )}
          </article>
        ))}
      </div>
      <Dialog
        open={editing !== null}
        onOpenChange={(value) => {
          if (!value) setEditing(null);
        }}
        title={editing === 'new' ? 'Новое мероприятие' : 'Редактировать мероприятие'}
        description={
          editing !== 'new' && editing?.publication
            ? 'Описание будет обновлено на публичной странице мероприятия.'
            : 'Черновик виден только вашей команде.'
        }
      >
        <form onSubmit={form.handleSubmit((data) => save.mutate(data))}>
          <Field
            label="Название мероприятия"
            readOnly={editing !== 'new' && !!editing?.publication}
            maxLength={160}
            error={form.formState.errors.title?.message}
            {...form.register('title')}
          />
          <label className="ef-field">
            <span>Описание</span>
            <textarea
              rows={5}
              maxLength={5000}
              readOnly={editing !== 'new' && !!editing?.collaborative && !editing.publication}
              {...form.register('description')}
            />
            {editing !== 'new' && editing?.collaborative && !editing.publication && (
              <small>
                Описание доступно в совместном редакторе. Здесь можно изменить название.
              </small>
            )}
          </label>
          <ErrorMessage error={save.error} />
          <Button type="submit" disabled={save.isPending}>
            {editing !== 'new' && editing?.publication
              ? 'Сохранить описание'
              : 'Сохранить черновик'}
          </Button>
        </form>
      </Dialog>
      <Dialog
        wide
        open={collaborating !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCollaborating(null);
            void queryClient.invalidateQueries({ queryKey: ['events', id] });
          }
        }}
        title="Совместный редактор"
        description={collaborating?.title ?? 'Описание черновика'}
      >
        {collaborating && (
          <Suspense fallback={<Loading />}>
            <CollaborativeEditor
              key={collaborating.id}
              organizationId={id}
              eventId={collaborating.id}
              subject={subject}
            />
          </Suspense>
        )}
      </Dialog>
      <Dialog
        open={admission !== null}
        onOpenChange={(open) => {
          if (!open) setAdmission(null);
        }}
        title="Контроль входа"
        description={admission ? admission.title : 'Проверка билетов'}
      >
        {admission && (
          <Suspense fallback={<Loading />}>
            <CheckIn key={admission.id} organizationId={id} eventId={admission.id} />
          </Suspense>
        )}
      </Dialog>
      <Dialog
        open={cover !== null}
        onOpenChange={(open) => {
          if (!open) setCover(null);
        }}
        title="Афиша мероприятия"
        description="Статичное изображение JPEG, PNG или WebP, до 5 MiB и 16 мегапикселей."
      >
        {cover && <EventCover id={id} event={cover} onSaved={() => setCover(null)} />}
      </Dialog>
      <Dialog
        wide
        open={configuring !== null}
        onOpenChange={(open) => {
          if (!open) setConfiguring(null);
        }}
        title="Настройки продажи"
        description="Заполните расписание, цены и схему мест. Настройки сохраняются в черновике."
      >
        {configuring && (
          <Suspense fallback={<Loading />}>
            <EventConfiguration
              key={configuring.id}
              id={id}
              event={configuring}
              onSaved={() => setConfiguring(null)}
            />
          </Suspense>
        )}
      </Dialog>
    </>
  );
}
