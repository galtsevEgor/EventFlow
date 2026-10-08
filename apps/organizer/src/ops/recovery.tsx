import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button, Dialog, Field } from '@eventflow/ui';
import { api, unwrap, ApiRequestError, type Schemas } from '../api';
import { ErrorMessage } from '../feedback';
import { isWorking, type Target } from './model';
import {
  readPending,
  writePending,
  removePending,
  recoveryKey,
  type PendingRecovery,
} from './pending';

export function RecoveryControl({
  actor,
  target,
  detail,
  refresh,
}: {
  actor: string;
  target: Target;
  detail: Schemas['OpsDetail'];
  refresh: (focus?: boolean) => void;
}) {
  const cacheKey = recoveryKey(actor, target),
    [pending, setPending] = useState(() => readPending(cacheKey)),
    [open, setOpen] = useState(false),
    [reason, setReason] = useState(pending?.reason ?? ''),
    [confirmed, setConfirmed] = useState(false),
    [notice, setNotice] = useState('');
  const recovery = useMutation({
    mutationFn: async (request: PendingRecovery) => {
      writePending(cacheKey, request);
      setPending(request);
      return unwrap(
        await api.client.POST('/api/v1/ops/issues/{service}/{kind}/{id}/recover', {
          params: { path: target, header: { 'idempotency-key': request.key } },
          body: { reason: request.reason, version: request.version },
        }),
      );
    },
    onSuccess: (_data, request) => {
      const accepted = { ...request, acknowledged: true };
      writePending(cacheKey, accepted);
      setPending(accepted);
      setOpen(false);
      refresh(true);
    },
    onError: (error) => {
      if (error instanceof ApiRequestError && !error.problem.retryable) {
        removePending(cacheKey);
        setPending(null);
        setConfirmed(false);
      }
      refresh();
    },
  });
  const reset = recovery.reset;
  useEffect(() => {
    if (
      !pending ||
      detail.version === pending.version ||
      !detail.actions.some((action) => action.key === pending.key)
    )
      return;
    if (!pending.acknowledged) {
      const accepted = { ...pending, acknowledged: true };
      writePending(cacheKey, accepted);
      setPending(accepted);
      setOpen(false);
      reset();
    }
    if (!isWorking(detail.issue.state)) {
      removePending(cacheKey);
      setPending(null);
      setNotice('Статус операции обновлён. Действие сохранено в журнале.');
    }
  }, [pending, detail, cacheKey, reset]);
  return (
    <section className="ops-recovery" aria-label="Восстановление">
      {notice && <p role="status">{notice}</p>}
      <ErrorMessage error={recovery.error} />
      {pending ? (
        <>
          <p role="status">
            {pending.acknowledged
              ? 'Запрос принят. Ожидаем результат обработки.'
              : 'Ответ мог потеряться. Повтор использует тот же ключ и ту же причину.'}
          </p>
          <p className="muted ops-id">Ключ действия: {pending.key}</p>
          {!pending.acknowledged && (
            <Button disabled={recovery.isPending} onClick={() => recovery.mutate(pending)}>
              Повторить запрос
            </Button>
          )}
        </>
      ) : detail.recoverable ? (
        <Button
          onClick={() => {
            setConfirmed(false);
            setOpen(true);
          }}
        >
          Запустить восстановление
        </Button>
      ) : (
        <p className="muted">Для текущего состояния повторная обработка недоступна.</p>
      )}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!recovery.isPending) setOpen(value);
        }}
        title="Запустить восстановление"
        description="Будет повторно запущен существующий обработчик. Итоговый статус появится после обработки."
      >
        <p className="ops-id">Запись: {target.id}</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (confirmed && reason.trim().length >= 8)
              recovery.mutate(
                pending ?? {
                  key: crypto.randomUUID(),
                  reason: reason.trim(),
                  version: detail.version,
                  acknowledged: false,
                },
              );
          }}
        >
          <Field
            label="Причина восстановления"
            value={pending?.reason ?? reason}
            minLength={8}
            maxLength={240}
            required
            disabled={Boolean(pending) || recovery.isPending}
            onChange={(event) => setReason(event.target.value)}
          />
          <label className="ops-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={recovery.isPending}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            Подтверждаю запуск сверки или повтора доставки
          </label>
          <ErrorMessage error={recovery.error} />
          <Button
            type="submit"
            disabled={!confirmed || reason.trim().length < 8 || recovery.isPending}
          >
            {recovery.isPending ? 'Отправляем…' : 'Подтвердить запуск'}
          </Button>
        </form>
      </Dialog>
    </section>
  );
}
