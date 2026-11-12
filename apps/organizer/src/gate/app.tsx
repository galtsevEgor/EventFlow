import { Component, useEffect, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { z } from 'zod';
import { Alert, Button } from '@eventflow/ui';
import { gateDatabase as db } from './database';
import { useGateIdentity } from './identity';
import { useGate } from './use-gate';
import { GatePreparation } from './preparation';
import { GateScanInput } from './scan-input';
import { GateScanQueue } from './scan-queue';
import { registerGateWorker } from './pwa';
import { Brand } from '../brand';
import './gate.css';
const SNAPSHOT_CLOCK_TICK_MS = 1_000;

function Gate({ organizationId, eventId }: { organizationId: string; eventId: string }) {
  const gate = useGate(organizationId, eventId);
  const [now, setNow] = useState(() => Date.now()),
    [update, setUpdate] = useState<ServiceWorkerRegistration | null>(null),
    [reloading, setReloading] = useState(false);
  const allPending = useLiveQuery(
    () => db.scans.filter((scan) => scan.state === 'PENDING').count(),
    [],
    0,
  );
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), SNAPSHOT_CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    void registerGateWorker(setUpdate).catch(() => {});
  }, []);
  const expired = gate.snapshot ? now >= Date.parse(gate.snapshot.manifest.expiresAt) : true;
  const canCapture =
    !!gate.worker &&
    !!gate.ready &&
    gate.ready === gate.snapshot?.id &&
    gate.actorMatches &&
    !expired &&
    !gate.snapshot?.blocked;
  const returnTo = location.pathname + location.search;
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
        <Brand href="/organizer/" caption="Сканер билетов" />
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
      <GatePreparation
        snapshot={gate.snapshot}
        expired={expired}
        canPrepare={Boolean(
          gate.online && gate.verifiedUser && !gate.prepare.isPending && gate.worker,
        )}
        onPrepare={() => gate.prepare.mutate()}
      />
      <GateScanInput
        worker={gate.worker}
        canCapture={canCapture}
        capturing={gate.capture.isPending}
        capture={gate.capture.mutate}
      />
      <GateScanQueue
        rows={gate.rows}
        now={now}
        canSync={Boolean(
          gate.online && gate.verifiedUser && gate.pending > 0 && !gate.sync.isPending,
        )}
        syncing={gate.sync.isPending}
        onSync={() => gate.sync.mutate()}
      />
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
      <header className="gate-header">
        <Brand href="/organizer/" />
      </header>
      <section aria-labelledby="gate-index-title">
        <h1 id="gate-index-title">Сканер билетов</h1>
        {identityError && <Alert>{identityError.message}</Alert>}
        <p>Подготовьте мероприятие из кабинета, пока есть сеть. Затем открывайте его здесь.</p>
        {session.data?.user === null && (
          <a
            className="ef-button login-link"
            href="/api/v1/auth/login?returnTo=%2Forganizer%2Fgate%2F"
          >
            Войти в аккаунт
          </a>
        )}
        {unique.length > 0 && (
          <ul className="gate-event-list">
            {unique.map((s) => (
              <li key={s.eventId}>
                <a href={'/organizer/gate/?org=' + s.organizationId + '&event=' + s.eventId}>
                  Мероприятие {s.eventId.slice(0, 8)}
                </a>
              </li>
            ))}
          </ul>
        )}
        <p>
          <a href="/organizer/">Открыть кабинет организатора</a>
        </p>
      </section>
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
