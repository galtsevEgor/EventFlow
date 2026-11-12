import { lazy, Suspense, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Badge, Button, Loading } from '@eventflow/ui';
import { api, loadSession, queryClient, unwrap } from './api';
import { ErrorMessage } from './feedback';
import { Organizations } from './organizations';
import { useOperatorAccess } from './ops/access';
import { clearOperatorRequests } from './ops/pending';
import { clearDraftCopies } from './collaboration/cache';
import { AUTH_SESSION_POLL_INTERVAL_MS } from '@eventflow/api-client';
const OperatorPage = lazy(() => import('./ops/page'));

export function App() {
  const session = useQuery({
    queryKey: ['session'],
    queryFn: loadSession,
    refetchInterval: AUTH_SESSION_POLL_INTERVAL_MS,
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
      clearOperatorRequests();
      clearDraftCopies();
      await import('./gate/database').then((m) => m.gateDatabase.identity(null)).catch(() => {});
      api.setCsrfToken('');
      location.assign(result.logoutUrl);
    },
  });
  const user = session.data?.user;
  const operator = useOperatorAccess(user?.sub),
    isOperatorPage = location.pathname.replace(/\/$/, '') === '/organizer/ops';
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
              {operator.data && <a href="/organizer/ops">Кабинет оператора</a>}
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
          {isOperatorPage ? (
            <h1>Кабинет оператора</h1>
          ) : (
            <h1>
              Соберите команду.
              <br />
              Создайте событие.
            </h1>
          )}
          <p>
            {isOperatorPage
              ? 'Войдите с учётной записью поддержки.'
              : 'Организации, участники и мероприятия — в одном кабинете.'}
          </p>
          <a
            className="ef-button login-link"
            href={`/api/v1/auth/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`}
          >
            Войти
          </a>
        </section>
      ) : isOperatorPage ? (
        operator.isPending ? (
          <Loading />
        ) : operator.isError ? (
          <>
            <ErrorMessage error={operator.error} />
            <Button onClick={() => void operator.refetch()}>Повторить проверку доступа</Button>
          </>
        ) : operator.data ? (
          <Suspense fallback={<Loading />}>
            <OperatorPage actor={user.sub} canRecover={operator.data.canRecover} />
          </Suspense>
        ) : (
          <section className="panel">
            <h1>Кабинет оператора</h1>
            <p role="alert">Нет доступа к кабинету оператора.</p>
            <a href="/organizer/">К организациям</a>
          </section>
        )
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
