import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Badge, Button, Field, Select } from '@eventflow/ui';
import { api, queryClient, roles, unwrap, type Schemas } from './api';
import { ErrorMessage } from './feedback';

const input = z.object({
  email: z.email('Укажите корректный email').max(254),
  role: z.enum(['MANAGER', 'STAFF']),
});
export function Invitations({ id }: { id: string }) {
  const [link, setLink] = useState('');
  const form = useForm({
    resolver: zodResolver(input),
    defaultValues: { email: '', role: 'MANAGER' as const },
  });
  const invitations = useQuery({
    queryKey: ['invitations', id],
    queryFn: async () =>
      unwrap(
        await api.client.GET('/api/v1/organizations/{id}/invitations', {
          params: { path: { id } },
        }),
      ),
  });
  const create = useMutation({
    mutationFn: async (body: z.infer<typeof input>) =>
      unwrap(
        await api.client.POST('/api/v1/organizations/{id}/invitations', {
          params: { path: { id } },
          body,
        }),
      ),
    onSuccess: async (invitation) => {
      setLink(`${location.origin}/organizer/?invite=${invitation.token}`);
      form.reset();
      await queryClient.invalidateQueries({ queryKey: ['invitations', id] });
      await queryClient.invalidateQueries({ queryKey: ['audit', id] });
    },
  });
  return (
    <section className="invite-panel">
      <h3>Пригласить участника</h3>
      <p className="muted">
        Ссылка действует 24 часа. Передайте её участнику: принять приглашение сможет только владелец
        указанного email.
      </p>
      <form className="invite-form" onSubmit={form.handleSubmit((data) => create.mutate(data))}>
        <Field
          label="Email участника"
          type="email"
          error={form.formState.errors.email?.message}
          {...form.register('email')}
        />
        <Select label="Роль приглашения" {...form.register('role')}>
          <option value="MANAGER">Менеджер</option>
          <option value="STAFF">Сотрудник</option>
        </Select>
        <Button type="submit" disabled={create.isPending}>
          Создать приглашение
        </Button>
      </form>
      <ErrorMessage error={create.error} />
      {link && (
        <div className="share-link" role="status">
          <Field
            label="Ссылка приглашения"
            value={link}
            readOnly
            onFocus={(event) => event.target.select()}
          />
          <p>Скопируйте ссылку сейчас: после закрытия страницы она не будет показана снова.</p>
        </div>
      )}
      <ErrorMessage error={invitations.error} />
      <ul className="invitations">
        {invitations.data?.invitations.map((invitation) => (
          <Invitation key={invitation.id} id={id} invitation={invitation} />
        ))}
      </ul>
    </section>
  );
}

function Invitation({ id, invitation }: { id: string; invitation: Schemas['Invitation'] }) {
  const revoke = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.client.DELETE('/api/v1/organizations/{id}/invitations/{invitationId}', {
          params: { path: { id, invitationId: invitation.id } },
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['invitations', id] });
      await queryClient.invalidateQueries({ queryKey: ['audit', id] });
    },
  });
  const status = invitation.acceptedAt
    ? 'Принято'
    : invitation.revokedAt
      ? 'Отозвано'
      : Date.parse(invitation.expiresAt) <= Date.now()
        ? 'Истекло'
        : 'Ожидает принятия';
  return (
    <li>
      <div className="member-row">
        <span>{invitation.email}</span>
        <Badge>{roles[invitation.role]}</Badge>
        <span className="muted">{status}</span>
        {status === 'Ожидает принятия' && (
          <Button variant="secondary" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
            Отозвать
          </Button>
        )}
      </div>
      <ErrorMessage error={revoke.error} />
    </li>
  );
}
