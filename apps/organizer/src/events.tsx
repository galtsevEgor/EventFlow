import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Badge, Button, Dialog, EmptyState, Field, Loading } from '@eventflow/ui';
import { api, queryClient, unwrap, type Schemas } from './api';
import { ErrorMessage } from './feedback';

const input = z.object({
  title: z.string().trim().min(2, 'Минимум 2 символа').max(160, 'Максимум 160 символов'),
  description: z.string().trim().max(5000),
});
export function Events({ id, role }: { id: string; role: Schemas['Role'] }) {
  const events = useQuery({
    queryKey: ['events', id],
    queryFn: async () =>
      unwrap(
        await api.client.GET('/api/v1/organizations/{id}/events', { params: { path: { id } } }),
      ),
  });
  const [editing, setEditing] = useState<Schemas['Draft'] | 'new' | null>(null);
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
            <Badge>Черновик</Badge>
            <h3>{event.title}</h3>
            <p>{event.description || 'Описание ещё не добавлено.'}</p>
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
        description="Черновик виден только вашей команде."
      >
        <form onSubmit={form.handleSubmit((data) => save.mutate(data))}>
          <Field
            label="Название мероприятия"
            maxLength={160}
            error={form.formState.errors.title?.message}
            {...form.register('title')}
          />
          <label className="ef-field">
            <span>Описание</span>
            <textarea rows={5} maxLength={5000} {...form.register('description')} />
          </label>
          <ErrorMessage error={save.error} />
          <Button type="submit" disabled={save.isPending}>
            Сохранить черновик
          </Button>
        </form>
      </Dialog>
    </>
  );
}
