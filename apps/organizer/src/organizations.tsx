import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Badge, Button, Dialog, EmptyState, Field, Loading } from '@eventflow/ui';
import { api, queryClient, roles, unwrap } from './api';
import { ErrorMessage } from './feedback';
import { Events } from './events';
import { Team } from './team';
import { SalesStatistics } from './sales-statistics';
import { OrderRefunds } from './order-refunds';

const input = z.object({
  name: z.string().trim().min(2, 'Минимум 2 символа').max(100, 'Максимум 100 символов'),
});

export function Organizations({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const list = useQuery({
    queryKey: ['organizations'],
    queryFn: async () => unwrap(await api.client.GET('/api/v1/organizations')),
  });
  const form = useForm({ resolver: zodResolver(input), defaultValues: { name: '' } });
  const create = useMutation({
    mutationFn: async (body: z.infer<typeof input>) =>
      unwrap(await api.client.POST('/api/v1/organizations', { body })),
    onSuccess: async (org) => {
      setOpen(false);
      form.reset();
      onSelect(org.id);
      await queryClient.invalidateQueries({ queryKey: ['organizations'] });
    },
  });
  const activeId = selected ?? list.data?.organizations[0]?.id;
  return (
    <section className="workspace">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Ваша команда</p>
          <h1>Организации</h1>
        </div>
        <Button
          onClick={() => {
            create.reset();
            setOpen(true);
          }}
        >
          Создать организацию
        </Button>
      </div>
      <ErrorMessage error={list.error} />
      {list.isPending && <Loading />}
      {list.data && (
        <div className="organization-tabs" aria-label="Организации">
          {list.data.organizations.map((org) => (
            <button
              className={org.id === activeId ? 'organization-tab active' : 'organization-tab'}
              aria-pressed={org.id === activeId}
              key={org.id}
              onClick={() => onSelect(org.id)}
            >
              <span>{org.name}</span>
              <Badge>{roles[org.role]}</Badge>
            </button>
          ))}
        </div>
      )}
      {list.data?.organizations.length === 0 && !selected && (
        <EmptyState title="Начните со своей команды">
          Создайте организацию, пригласите участников и сохраните первое мероприятие.
        </EmptyState>
      )}
      {activeId && <Organization key={activeId} id={activeId} />}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Новая организация"
        description="Вы станете владельцем и сможете приглашать участников."
      >
        <form onSubmit={form.handleSubmit((data) => create.mutate(data))}>
          <Field
            label="Название организации"
            maxLength={100}
            error={form.formState.errors.name?.message}
            {...form.register('name')}
          />
          <ErrorMessage error={create.error} />
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? 'Создание…' : 'Создать'}
          </Button>
        </form>
      </Dialog>
    </section>
  );
}

function Organization({ id }: { id: string }) {
  const org = useQuery({
    queryKey: ['organization', id],
    queryFn: async () =>
      unwrap(await api.client.GET('/api/v1/organizations/{id}', { params: { path: { id } } })),
  });
  const [tab, setTab] = useState<'events' | 'team' | 'statistics' | 'orders'>('events');
  const [editing, setEditing] = useState(false);
  const form = useForm({ resolver: zodResolver(input), defaultValues: { name: '' } });
  const rename = useMutation({
    mutationFn: async (body: z.infer<typeof input>) =>
      unwrap(
        await api.client.PATCH('/api/v1/organizations/{id}', { params: { path: { id } }, body }),
      ),
    onSuccess: async () => {
      setEditing(false);
      await queryClient.invalidateQueries();
    },
  });
  if (org.isPending) return <Loading />;
  if (org.error || !org.data) return <ErrorMessage error={org.error} />;
  return (
    <section className="panel">
      <div className="section-heading">
        <div>
          <h2>{org.data.name}</h2>
          <Badge>{roles[org.data.role]}</Badge>
        </div>
        {org.data.role === 'OWNER' && (
          <Button
            variant="secondary"
            onClick={() => {
              form.reset({ name: org.data.name });
              rename.reset();
              setEditing(true);
            }}
          >
            Переименовать
          </Button>
        )}
      </div>
      <nav className="section-tabs" aria-label="Разделы организации">
        {org.data.role !== 'STAFF' && (
          <Button
            variant={tab === 'orders' ? 'primary' : 'secondary'}
            onClick={() => setTab('orders')}
          >
            Заказы
          </Button>
        )}
        {org.data.role !== 'STAFF' && (
          <Button
            variant={tab === 'statistics' ? 'primary' : 'secondary'}
            onClick={() => setTab('statistics')}
          >
            Статистика
          </Button>
        )}
        <Button
          variant={tab === 'events' ? 'primary' : 'secondary'}
          onClick={() => setTab('events')}
        >
          Мероприятия
        </Button>
        {org.data.role === 'OWNER' && (
          <Button variant={tab === 'team' ? 'primary' : 'secondary'} onClick={() => setTab('team')}>
            Команда
          </Button>
        )}
      </nav>
      {tab === 'orders' && org.data.role !== 'STAFF' ? (
        <OrderRefunds key={id} id={id} />
      ) : tab === 'statistics' && org.data.role !== 'STAFF' ? (
        <SalesStatistics key={id} id={id} />
      ) : tab === 'team' && org.data.role === 'OWNER' ? (
        <Team id={id} />
      ) : (
        <Events id={id} role={org.data.role} />
      )}
      <Dialog
        open={editing}
        onOpenChange={setEditing}
        title="Название организации"
        description="Новое название будет видно всем участникам."
      >
        <form onSubmit={form.handleSubmit((data) => rename.mutate(data))}>
          <Field
            label="Название"
            error={form.formState.errors.name?.message}
            {...form.register('name')}
          />
          <ErrorMessage error={rename.error} />
          <Button type="submit" disabled={rename.isPending}>
            Сохранить
          </Button>
        </form>
      </Dialog>
    </section>
  );
}
