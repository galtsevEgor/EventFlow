import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import { z } from 'zod';
import { offlineBundleSchema, offlinePublicKeySchema } from '@eventflow/event-contracts';
import { gateDatabase as db, type Snapshot } from './database';
import { importPublicKey } from './crypto';
import { gateRequest } from './api';
import { useGateIdentity } from './identity';
import { synchronize, GateSyncError } from './sync';
import { ScannerWorker } from './worker-client';

const GATE_AUTO_SYNC_INTERVAL_MS = 15_000;

export function useGate(organizationId: string, eventId: string) {
  const [online, setOnline] = useState(navigator.onLine),
    [worker, setWorker] = useState<ScannerWorker | null>(null);
  const [ready, setReady] = useState<string | null>(null),
    [storageError, setStorageError] = useState<Error | null>(null);
  const lastAutomatic = useRef(0);
  useEffect(() => {
    const instance = new ScannerWorker();
    setWorker(instance);
    return () => instance.close();
  }, []);
  const { session, verifiedUser, actorMatches, actor, identityError } = useGateIdentity(online);
  useEffect(() => {
    const changed = () => {
      setOnline(navigator.onLine);
      if (navigator.onLine) void session.refetch();
    };
    window.addEventListener('online', changed);
    window.addEventListener('offline', changed);
    return () => {
      window.removeEventListener('online', changed);
      window.removeEventListener('offline', changed);
    };
  }, [session.refetch]);
  const snapshot = useLiveQuery(
    () => (actor ? db.latest(actor, eventId) : undefined),
    [actor, eventId],
  );
  const rows = useLiveQuery(
    () =>
      actor
        ? db.scans.where('[actorSubject+eventId]').equals([actor, eventId]).sortBy('capturedAt')
        : [],
    [actor, eventId],
    [],
  );
  const csrf = session.data?.user ? session.data.csrfToken : '';
  const snapshotContext = useMemo(
    () =>
      snapshot
        ? {
            actorSubject: snapshot.actorSubject,
            organizationId,
            eventId,
            deviceId: snapshot.deviceId,
          }
        : null,
    [snapshot, organizationId, eventId],
  );
  useEffect(() => {
    let cancelled = false;
    setReady(null);
    if (worker && snapshot && snapshotContext && actorMatches && !snapshot.blocked)
      void worker
        .initialize(snapshot.bundle, snapshot.keyId, snapshot.publicKey, snapshotContext)
        .then(() => {
          if (!cancelled) setReady(snapshot.id);
        })
        .catch((error) => {
          if (!cancelled)
            setStorageError(error instanceof Error ? error : new Error('Снимок повреждён.'));
        });
    return () => {
      cancelled = true;
    };
  }, [worker, snapshot, snapshotContext, actorMatches]);
  const prepare = useMutation({
    mutationFn: async () => {
      setStorageError(null);
      if (!verifiedUser || !worker) throw new Error('Войдите и подтвердите email.');
      if (!navigator.locks)
        throw new Error(
          'Этот браузер не поддерживает безопасную синхронизацию. Откройте сканер в актуальном Chrome, Edge или Firefox.',
        );
      const deviceId = await db.device();
      const keyData = z
        .strictObject({ keys: z.array(offlinePublicKeySchema).min(1).max(10) })
        .parse(await gateRequest('keys', csrf));
      const bundle = offlineBundleSchema.parse(
        await gateRequest('sessions', csrf, { organizationId, eventId, deviceId }),
      );
      const advertised = keyData.keys.find((k) => k.id === bundle.keyId);
      if (!advertised) throw new Error('Ключ снимка неизвестен. Повторите подготовку.');
      const key = await importPublicKey(advertised);
      const manifest = await worker.initialize(bundle, key.id, key.key, {
        actorSubject: verifiedUser.sub,
        organizationId,
        eventId,
        deviceId,
      });
      const record: Snapshot = {
        id: manifest.sessionId,
        actorSubject: verifiedUser.sub,
        organizationId,
        eventId,
        deviceId,
        bundle,
        manifest,
        keyId: key.id,
        publicKey: key.key,
        blocked: false,
      };
      await db.saveSnapshot(record);
      return record;
    },
  });
  const capture = useMutation({
    networkMode: 'always',
    mutationFn: async (credential: string) => {
      setStorageError(null);
      if (!actorMatches || !worker || !snapshot || ready !== snapshot.id || snapshot.blocked)
        throw new Error('Сначала подготовьте мероприятие онлайн.');
      const now = Date.now();
      await worker.check(credential, now);
      try {
        return await db.capture(snapshot, credential, now);
      } catch (error) {
        if (error instanceof Error && error.name === 'QuotaExceededError')
          throw new Error(
            'Не удалось сохранить проверку: хранилище заполнено. Освободите место и повторите сканирование.',
            { cause: error },
          );
        throw error;
      }
    },
  });
  const sync = useMutation({
    mutationFn: async () => {
      if (!verifiedUser || verifiedUser.sub !== actor)
        throw new Error('Для синхронизации войдите в исходный аккаунт.');
      await synchronize(db, actor, eventId, (body) => gateRequest('sync', csrf, body));
    },
    onError: (error) => {
      if (error instanceof GateSyncError && (error.status === 401 || error.code === 'CSRF_FAILED'))
        void session.refetch();
    },
  });
  const pending = rows?.filter((r) => r.state === 'PENDING').length ?? 0;
  const automatic = useCallback(() => {
    if (
      navigator.onLine &&
      verifiedUser?.sub === actor &&
      pending > 0 &&
      !(
        sync.error instanceof GateSyncError &&
        sync.error.status >= 400 &&
        sync.error.status < 500
      ) &&
      !sync.isPending &&
      Date.now() - lastAutomatic.current > GATE_AUTO_SYNC_INTERVAL_MS
    ) {
      lastAutomatic.current = Date.now();
      sync.mutate();
    }
  }, [verifiedUser, actor, pending, sync.isPending, sync.error, sync.mutate]);
  useEffect(() => {
    automatic();
    const timer = setInterval(automatic, GATE_AUTO_SYNC_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [automatic]);
  const discard = useMutation({
    networkMode: 'always',
    mutationFn: async () => {
      if (!actor) throw new Error('Аккаунт недоступен.');
      await db.discard(actor, eventId);
    },
  });
  return {
    online,
    worker,
    session,
    actor,
    snapshot,
    rows: rows ?? [],
    pending,
    ready,
    actorMatches,
    verifiedUser,
    prepare,
    capture,
    sync,
    discard,
    error:
      storageError ??
      identityError ??
      prepare.error ??
      capture.error ??
      sync.error ??
      discard.error,
  };
}
