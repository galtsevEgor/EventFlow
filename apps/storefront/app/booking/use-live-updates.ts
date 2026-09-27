'use client';
import { useEffect, useState } from 'react';
import { watchUpdates } from '@eventflow/api-client';

export function useLiveUpdates(path: string | null, refresh: () => Promise<unknown>) {
  const [connection, setConnection] = useState<{ path: string; connected: boolean } | null>(null);
  useEffect(() => {
    if (!path) return;
    return watchUpdates(path, {
      onUpdate: refresh,
      onConnection: (connected) => setConnection({ path, connected }),
    });
  }, [path, refresh]);
  return Boolean(path && connection?.path === path && connection.connected);
}
