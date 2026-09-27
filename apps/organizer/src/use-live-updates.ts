import { useEffect, useState } from 'react';
import { watchUpdates } from '@eventflow/api-client';

export function useLiveUpdates(path: string, refresh: () => Promise<unknown>) {
  const [connection, setConnection] = useState<{ path: string; connected: boolean } | null>(null);
  useEffect(
    () =>
      watchUpdates(path, {
        onUpdate: refresh,
        onConnection: (connected) => setConnection({ path, connected }),
      }),
    [path, refresh],
  );
  return connection?.path === path && connection.connected;
}
