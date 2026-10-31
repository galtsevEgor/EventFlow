import { Component, useCallback, useEffect, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { z } from 'zod';
import { Alert, Button, Field } from '@eventflow/ui';
import { gateDatabase as db, type Scan } from './database';
import { useGateIdentity } from './identity';
import { useGate } from './use-gate';
import { GateCamera } from './camera';
import { registerGateWorker } from './pwa';
import './gate.css';
const labels = {
  ADMITTED: 'Допуск подтверждён сервером',
  ALREADY_USED: 'Конфликт: билет уже использован',
  WRONG_EVENT: 'Билет другого мероприятия',
  INVALID_TICKET: 'Билет не найден',
  WINDOW_CLOSED: 'Окно допуска закрыто',
  REFUND_PENDING: 'Возврат проверяется',
  REFUNDED: 'Билет аннулирован',
};
function ScanResult({ scan }: { scan: Scan }) {
  return (
    <li
      className={
        'gate-result ' +
        (scan.state === 'PENDING'
          ? 'pending'
          : scan.result?.result === 'ADMITTED'
            ? 'confirmed'
            : 'conflict')
      }
    >
      <strong>
        {scan.state === 'PENDING'
          ? 'Сохранено на устройстве — ожидает синхронизации'
          : scan.result?.reason === 'SNAPSHOT_EXPIRED'
            ? 'Снимок истёк до синхронизации'
            : scan.result?.reason === 'NOT_IN_SNAPSHOT'
              ? 'Билет отсутствует в снимке'
              : scan.result
                ? labels[scan.result.result]
                : 'Нет результата'}
      </strong>
      <small>
        {new Date(scan.capturedAt).toLocaleString('ru')} · операция {scan.requestId.slice(0, 8)}
      </small>
    </li>
  );
}
function Gate({ organizationId, eventId }: { organizationId: string; eventId: string }) {
  const gate = useGate(organizationId, eventId),
    [credential, setCredential] = useState(''),
    [camera, setCamera] = useState(false);
  const [now, setNow] = useState(() => Date.now()),
    [update, setUpdate] = useState<ServiceWorkerRegistration | null>(null),
    [reloading, setReloading] = useState(false);
  const allPending = useLiveQuery(
    () => db.scans.filter((scan) => scan.state === 'PENDING').count(),
    [],
    0,
  );
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    void registerGateWorker(setUpdate).catch(() => {});
  }, []);
  const submit = useCallback(
    (code: string) => {
      setCamera(false);
      gate.capture.mutate(code, { onSuccess: () => setCredential('') });
    },
    [gate.capture.mutate],
  );
  const expired = gate.snapshot ? now >= Date.parse(gate.snapshot.manifest.expiresAt) : true;
  const canCapture =
    !!gate.worker &&
    !!gate.ready &&
    gate.ready === gate.snapshot?.id &&
    gate.actorMatches &&
    !expired &&
    !gate.snapshot?.blocked;
  const returnTo = location.pathname + location.search;
  const pendingRows = gate.rows.filter((scan) => scan.state === 'PENDING');
  const confirmed = gate.rows.filter((scan) => scan.result?.result === 'ADMITTED').length;
  const attention = gate.rows.length - pendingRows.length - confirmed;
  const oldestMinutes = pendingRows.length
    ? Math.max(
        0,
        Math.floor(
          (now - Math.min(...pendingRows.map((scan) => Date.parse(scan.capturedAt)))) / 60000,
        ),
      )
    : 0;
  async function applyUpdate() {
    if (await db.scans.filter((scan) => scan.state === 'PENDING').count()) return;
    setReloading(true);
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), {
      once: true,
    });
    update?.waiting?.postMessage({ type: 'ACTIVATE_UPDATE' });
  }
  return (
    <main className="gate-shell">
      <header className="gate-header">
        <a href="/organizer/" className="brand">
          EventFlow <span>Сканер билетов</span>
        </a>
        <a href="/organizer/gate/">Подготовленные события</a>
      </header>
      <h1>Проверка билетов</h1>
      <p className={'gate-connection ' + (gate.online ? 'online' : 'offline')} role="status">
        {gate.online ? 'Есть подключение' : 'Офлайн · проверки сохраняются на устройстве'}
      </p>
      <p className="muted">Мероприятие {eventId.slice(0, 8)}</p>
      <aside className="gate-notice">
        Проверка без сети предварительная. До ответа сервера допуск не подтверждён: другой сканер
        или возврат могут изменить результат.
      </aside>
      {!gate.verifiedUser && (
        <p>
          <a href={'/api/v1/auth/login?returnTo=' + encodeURIComponent(returnTo)}>
            Войти для подготовки и синхронизации
          </a>
        </p>
      )}
      {gate.session.data?.user && !gate.session.data.user.emailVerified && (
        <Alert>Подтвердите email.</Alert>
      )}
      <section aria-label="Подготовка сканера">
        <h2>Подготовка</h2>
        <Button
          disabled={!gate.online || !gate.verifiedUser || gate.prepare.isPending || !gate.worker}
          onClick={() => gate.prepare.mutate()}
        >
          Подготовить мероприятие
        </Button>
        {gate.snapshot && (
          <p>
            В снимке: {gate.snapshot.manifest.hashes.length} билетов. Действует до{' '}
            <time dateTime={gate.snapshot.manifest.expiresAt}>
              {new Date(gate.snapshot.manifest.expiresAt).toLocaleTimeString('ru')}
            </time>
            .
          </p>
        )}
        {expired && gate.snapshot && (
          <Alert>
            Снимок устарел. Обновите подготовку онлайн. Сохранённые проверки остаются в очереди.
          </Alert>
        )}
        {gate.snapshot?.blocked && (
          <Alert>
            Права на мероприятие изменились. Подготовьте снимок заново после восстановления доступа.
          </Alert>
        )}
      </section>
      <section aria-label="Сканирование">
        <h2>Сканировать билет</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submit(credential.trim());
          }}
        >
          <Field
            label="Код билета"
            value={credential}
            onChange={(event) => setCredential(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            disabled={!canCapture || gate.capture.isPending}
          />
          <div className="gate-actions">
            <Button
              type="submit"
              disabled={
                !canCapture ||
                gate.capture.isPending ||
                !/^[A-Za-z0-9_-]{32}$/.test(credential.trim())
              }
            >
              Сохранить проверку
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={!canCapture || gate.capture.isPending}
              onClick={() => setCamera(!camera)}
            >
              {camera ? 'Закрыть камеру' : 'Открыть камеру'}
            </Button>
          </div>
        </form>
        {camera && gate.worker && <GateCamera worker={gate.worker} onCode={submit} />}
        {gate.capture.isPending && <p role="status">Сохраняем проверку…</p>}
      </section>
      <section aria-label="Очередь синхронизации">
        <h2>Очередь: {gate.pending}</h2>
        <p className="muted">
          Подтверждено: {confirmed} · Требует внимания: {attention}
          {gate.pending > 0 && <> · Старейшая проверка ожидает {oldestMinutes} мин.</>}
        </p>
        <Button
          disabled={!gate.online || !gate.verifiedUser || gate.pending === 0 || gate.sync.isPending}
          onClick={() => gate.sync.mutate()}
        >
          {gate.sync.isPending ? 'Синхронизируем…' : 'Синхронизировать'}
        </Button>
        <p className="muted">
          Отправляем при открытом приложении. При потере ответа повторяем сохранённую операцию.
        </p>
        <ol className="gate-results">
          {gate.rows
            .slice()
            .reverse()
            .slice(0, 50)
            .map((scan) => (
              <ScanResult key={scan.requestId} scan={scan} />
            ))}
        </ol>
        {gate.rows.length === 0 && <p>На этом устройстве пока нет проверок.</p>}
      </section>
      {gate.error && <Alert>{gate.error.message}</Alert>}
      {update && (
        <aside className="gate-notice">
          <p>Доступно обновление сканера. Сначала синхронизируйте очередь во всех вкладках.</p>
          <Button
            disabled={allPending > 0 || gate.sync.isPending || reloading}
            onClick={() => void applyUpdate()}
          >
            Обновить приложение
          </Button>
        </aside>
      )}
      {!import.meta.env.PROD && (
        <p className="muted">Перезапуск без сети проверяется в локальной собранной версии PWA.</p>
      )}
      <Button
        variant="secondary"
        disabled={gate.sync.isPending || gate.capture.isPending || !gate.actor}
        onClick={() => {
          if (
            confirm(
              'Удалить локальный снимок и историю этого мероприятия? Несинхронизированные проверки будут потеряны.',
            )
          )
            gate.discard.mutate();
        }}
      >
        Удалить локальные данные
      </Button>
    </main>
  );
}
function GateIndex() {
  const { session, actor, identityError } = useGateIdentity(navigator.onLine);
  const snapshots = useLiveQuery(
    () => (actor ? db.snapshots.filter((s) => s.actorSubject === actor).toArray() : []),
    [actor],
    [],
  );
  useEffect(() => {
    void registerGateWorker(() => {}).catch(() => {});
  }, []);
  const unique = [...new Map((snapshots ?? []).map((s) => [s.eventId, s])).values()];
  return (
    <main className="gate-shell">
      <a className="brand" href="/organizer/">
        EventFlow
      </a>
      <h1>Сканер билетов</h1>
      {identityError && <Alert>{identityError.message}</Alert>}
      <p>Подготовьте мероприятие из кабинета, пока есть сеть. Затем открывайте его здесь.</p>
      {session.data?.user === null && (
        <a href="/api/v1/auth/login?returnTo=%2Forganizer%2Fgate%2F">Войти в аккаунт</a>
      )}
      <ul>
        {unique.map((s) => (
          <li key={s.eventId}>
            <a href={'/organizer/gate/?org=' + s.organizationId + '&event=' + s.eventId}>
              Мероприятие {s.eventId.slice(0, 8)}
            </a>
          </li>
        ))}
      </ul>
      <a href="/organizer/">Открыть кабинет организатора</a>
    </main>
  );
}
class GateBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <main className="gate-shell">
        <h1>Локальное хранилище недоступно</h1>
        <Alert>
          Проверки не подтверждены. Проверьте доступность хранилища браузера и откройте сканер
          заново.
        </Alert>
        <a href="/organizer/">Вернуться в кабинет</a>
      </main>
    ) : (
      this.props.children
    );
  }
}
export function GateApp() {
  const query = new URLSearchParams(location.search),
    ids = z
      .object({ organizationId: z.uuid(), eventId: z.uuid() })
      .safeParse({ organizationId: query.get('org'), eventId: query.get('event') });
  return (
    <GateBoundary>
      {ids.success ? (
        <Gate organizationId={ids.data.organizationId} eventId={ids.data.eventId} />
      ) : (
        <GateIndex />
      )}
    </GateBoundary>
  );
}
