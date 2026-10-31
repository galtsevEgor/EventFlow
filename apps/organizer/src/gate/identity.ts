import { useQuery } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import { gateDatabase as db } from './database';
import { gateSession } from './api';

class GateStorageError extends Error {}

export function useGateIdentity(online: boolean) {
  const session = useQuery({
    queryKey: ['gate-session'],
    retry: false,
    refetchInterval: 60000,
    queryFn: async () => {
      const value = await gateSession();
      try {
        await db.identity(value.user?.emailVerified ? value.user.sub : null);
      } catch {
        throw new GateStorageError('Локальное хранилище недоступно. Проверки не сохраняются.');
      }
      return value;
    },
  });
  const storedActor = useLiveQuery(() => db.activeActor(), [], null);
  const verifiedUser = session.data?.user?.emailVerified ? session.data.user : null;
  const actorMatches =
    !!storedActor &&
    !(session.error instanceof GateStorageError) &&
    (verifiedUser?.sub === storedActor || (!session.data && (session.isError || !online)));
  return {
    session,
    verifiedUser,
    actorMatches,
    actor: actorMatches ? storedActor : null,
    identityError: session.error instanceof GateStorageError ? session.error : null,
  };
}
