import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, Loading } from '@eventflow/ui';
import { api, loadSession, queryClient, unwrap } from './api';
import { ErrorMessage } from './feedback';
import { Organizations } from './organizations';

export function App() {
  const session = useQuery({
    queryKey: ['session'],
    queryFn: loadSession,
    refetchInterval: 60_000,
  });
  const [invite, setInvite] = useState(() => new URLSearchParams(location.search).get('invite'));
  const [selected, setSelected] = useState(() => new URLSearchParams(location.search).get('org'));
  function select(id: string) {
    history.replaceState(null, '', `/organizer/?org=${encodeURIComponent(id)}`);
    setSelected(id);
  }
  const accept = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.client.POST('/api/v1/invitations/accept', { body: { token: invite ?? '' } }),
      ),
    onSuccess: async (result) => {
      setInvite(null);
      select(result.organizationId);
      await queryClient.invalidateQueries();
    },
  });
  const logout = useMutation({
    mutationFn: async () => {
      const result = unwrap(await api.client.POST('/api/v1/auth/logout'));
      queryClient.clear();
      api.setCsrfToken('');
      location.assign(result.logoutUrl);
    },
  });
  const user = session.data?.user;
  return (
    <main>
      <header className="topbar">
        <a className="brand" href="/">
          EventFlow<span>Кабинет организатора</span>
        </a>
        <nav aria-label="Аккаунт">
          {user && (
            <>
              <span className="account-email">{user.email}</span>
              <Button
                variant="secondary"
                disabled={logout.isPending}
                onClick={() => logout.mutate()}
              >
                Выйти
              </Button>
            </>
          )}
        </nav>
      </header>
      <ErrorMessage error={logout.error} />
      <ErrorMessage error={session.error} />
      {session.isPending ? (
        <Loading />
      ) : !user ? (
        <section className="welcome">
          <Badge>Ваше пространство для событий</Badge>
          <h1>
            Соберите команду.
            <br />
            Создайте событие.
          </h1>
          <p>Организации, участники и мероприятия — в одном кабинете.</p>
          <a
            className="ef-button login-link"
            href={`/api/v1/auth/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`}
          >
            Войти
          </a>
        </section>
      ) : (
        <>
          {invite && (
            <section className="panel invitation">
              <h2>Вас пригласили в команду</h2>
              <p>
                Примите приглашение под аккаунтом с email, на который оно выдано. Вы вошли как{' '}
                {user.email}.
              </p>
              <ErrorMessage error={accept.error} />
              <Button disabled={accept.isPending} onClick={() => accept.mutate()}>
                Принять приглашение
              </Button>
            </section>
          )}
          <Organizations selected={selected} onSelect={select} />
        </>
      )}
      <footer>EventFlow · Пространство для хороших событий</footer>
    </main>
  );
}
