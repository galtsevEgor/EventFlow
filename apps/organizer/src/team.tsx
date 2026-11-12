import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, Loading, Select } from '@eventflow/ui';
import { api, queryClient, roles, unwrap, type Schemas } from './api';
import { ErrorMessage } from './feedback';
import { eventListOptions } from './event-queries';
import { Invitations } from './invitations';

export function Team({ id }: { id: string }) {
  const members = useQuery({
    queryKey: ['members', id],
    queryFn: async () =>
      unwrap(
        await api.client.GET('/api/v1/organizations/{id}/members', { params: { path: { id } } }),
      ),
  });
  const events = useQuery(eventListOptions(id));
  return (
    <>
      <h3>Участники команды</h3>
      <p className="muted">
        Владелец управляет доступом. Менеджер создаёт события. Сотрудник работает с назначенными
        событиями.
      </p>
      <ErrorMessage error={members.error} />
      <ErrorMessage error={events.error} />
      {members.isPending && <Loading />}
      <div className="member-list">
        {members.data?.members.map((member) => (
          <Member
            key={member.userSubject}
            id={id}
            member={member}
            events={events.data?.events ?? []}
          />
        ))}
      </div>
      <Invitations id={id} />
      <Audit id={id} />
    </>
  );
}

function Member({
  id,
  member,
  events,
}: {
  id: string;
  member: Schemas['Member'];
  events: Schemas['Draft'][];
}) {
  const params = { path: { id, user: member.userSubject } };
  const change = useMutation({
    mutationFn: async (role: Schemas['Role']) =>
      unwrap(
        await api.client.PATCH('/api/v1/organizations/{id}/members/{user}', {
          params,
          body: { role },
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries(),
  });
  const remove = useMutation({
    mutationFn: async () =>
      unwrap(await api.client.DELETE('/api/v1/organizations/{id}/members/{user}', { params })),
    onSuccess: () => queryClient.invalidateQueries(),
  });
  const assign = useMutation({
    mutationFn: async ({ eventId, assigned }: { eventId: string; assigned: boolean }) =>
      unwrap(
        await api.client.PUT('/api/v1/organizations/{id}/members/{user}/events/{eventId}', {
          params: { path: { ...params.path, eventId } },
          body: { assigned },
        }),
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['members', id] }),
  });
  const busy = change.isPending || remove.isPending || assign.isPending;
  return (
    <article className="member-card" aria-label={member.email}>
      <div className="member-row">
        <strong>{member.email}</strong>
        <Select
          label={`Роль ${member.email}`}
          value={member.role}
          disabled={busy}
          onChange={(event) => {
            const role = event.target.value as Schemas['Role'];
            if (window.confirm(`Изменить роль ${member.email} на «${roles[role]}»?`))
              change.mutate(role);
          }}
        >
          {Object.entries(roles).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        <Button
          variant="danger"
          disabled={busy}
          onClick={() => {
            if (window.confirm(`Удалить ${member.email} из организации?`)) remove.mutate();
          }}
        >
          Удалить
        </Button>
      </div>
      <ErrorMessage error={change.error || remove.error || assign.error} />
      {member.role === 'STAFF' && (
        <fieldset className="assignments">
          <legend>Назначенные мероприятия</legend>
          {events.length === 0 && <p className="muted">Сначала создайте мероприятие.</p>}
          {events.map((event) => (
            <label key={event.id}>
              <input
                type="checkbox"
                disabled={busy}
                checked={
                  assign.isPending && assign.variables.eventId === event.id
                    ? assign.variables.assigned
                    : member.assignments.some((item) => item.eventId === event.id)
                }
                onChange={(changeEvent) =>
                  assign.mutate({ eventId: event.id, assigned: changeEvent.target.checked })
                }
              />
              {event.title}
            </label>
          ))}
        </fieldset>
      )}
    </article>
  );
}

const auditLabels: Record<string, string> = {
  'organization.created': 'Организация создана',
  'organization.renamed': 'Название изменено',
  'membership.role_changed': 'Роль участника изменена',
  'membership.removed': 'Участник удалён',
  'invitation.created': 'Приглашение создано',
  'invitation.accepted': 'Приглашение принято',
  'invitation.revoked': 'Приглашение отозвано',
  'draft.created': 'Черновик создан',
  'draft.updated': 'Черновик обновлён',
  'staff.assigned': 'Событие назначено сотруднику',
  'staff.unassigned': 'Назначение отменено',
};
function Audit({ id }: { id: string }) {
  const audit = useQuery({
    queryKey: ['audit', id],
    queryFn: async () =>
      unwrap(
        await api.client.GET('/api/v1/organizations/{id}/audit', { params: { path: { id } } }),
      ),
  });
  return (
    <details className="audit">
      <summary>История изменений</summary>
      <ErrorMessage error={audit.error} />
      {audit.isPending && <Loading />}
      <ul>
        {audit.data?.entries.map((entry) => (
          <li key={entry.id}>
            <Badge>{new Date(entry.createdAt).toLocaleString('ru-RU')}</Badge>{' '}
            {auditLabels[entry.action] ?? 'Доступ к организации изменён'}
          </li>
        ))}
      </ul>
    </details>
  );
}
