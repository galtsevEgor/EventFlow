import { lazy, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Field, Loading } from '@eventflow/ui';
import { api, ApiRequestError, unwrap, type Schemas } from './api';

const Camera = lazy(() =>
  import('./check-in-camera').then(({ CheckInCamera }) => ({ default: CheckInCamera })),
);
const codePattern = /^[A-Za-z0-9_-]{32}$/;
const results = {
  ADMITTED: 'Вход разрешён',
  ALREADY_USED: 'Билет уже использован',
  WRONG_EVENT: 'Билет на другое мероприятие',
  INVALID_TICKET: 'Билет не найден',
  WINDOW_CLOSED: 'Допуск сейчас закрыт',
  REFUND_PENDING: 'Билет заблокирован на время возврата',
  REFUNDED: 'Билет аннулирован после возврата',
} satisfies Record<Schemas['CheckInResponse']['result'], string>;

export function CheckIn({ organizationId, eventId }: { organizationId: string; eventId: string }) {
  const [code, setCode] = useState('');
  const [camera, setCamera] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const check = useMutation({
    mutationFn: async (body: Schemas['CheckInInput']) =>
      unwrap(await api.client.POST('/api/v1/check-in', { body })),
    gcTime: 0,
  });
  useEffect(() => {
    if (check.data) input.current?.focus({ preventScroll: true });
  }, [check.data]);
  const { mutate } = check;
  const submit = useCallback(
    (credential: string) => {
      if (!codePattern.test(credential)) return;
      const request = { credential, organizationId, eventId, requestId: crypto.randomUUID() };
      setCamera(false);
      setCode('');
      mutate(request);
    },
    [eventId, organizationId, mutate],
  );
  function manual(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!check.isPending) submit(code.trim());
  }

  const retryable =
    check.error && (!(check.error instanceof ApiRequestError) || check.error.problem.retryable);
  return (
    <div className="check-in">
      <form onSubmit={manual}>
        <Field
          ref={input}
          label="Код билета"
          value={code}
          disabled={check.isPending}
          onChange={(event) => setCode(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
        />
        <Button type="submit" disabled={check.isPending || !codePattern.test(code.trim())}>
          Проверить билет
        </Button>
        <Button variant="secondary" disabled={check.isPending} onClick={() => setCamera(!camera)}>
          {camera ? 'Выключить камеру' : 'Включить камеру'}
        </Button>
      </form>
      {camera && (
        <Suspense fallback={<Loading />}>
          <Camera onCode={submit} />
        </Suspense>
      )}
      {check.isPending && <p role="status">Ждём ответ сервера…</p>}
      {check.error && (
        <Alert>
          {retryable
            ? 'Допуск не подтверждён. Проверьте связь и повторите запрос.'
            : check.error.message}
          {retryable && check.variables && (
            <Button onClick={() => check.variables && mutate(check.variables)}>
              Повторить проверку
            </Button>
          )}
        </Alert>
      )}
      {check.data && (
        <div
          role="status"
          className={`check-in-result${check.data.result === 'ADMITTED' ? ' check-in-admitted' : ''}`}
        >
          <strong>{results[check.data.result]}</strong>
          {check.data.admittedAt && (
            <p>
              Первый допуск{' '}
              <time dateTime={check.data.admittedAt}>
                {new Date(check.data.admittedAt).toLocaleString('ru')}
              </time>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
