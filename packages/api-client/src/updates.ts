import { z } from 'zod';
import type { components } from './schema';

const frame = z.strictObject({
  kind: z.enum(['ready', 'changed', 'heartbeat']),
}) satisfies z.ZodType<components['schemas']['UpdateFrame']>;
const route =
  /^\/api\/v1\/(?:(?:sales|orders|waitlist)\/[a-f0-9-]{36}\/updates|organizations\/[a-f0-9-]{36}\/events\/[a-f0-9-]{36}\/orders\/updates)$/i;
type Source = Pick<EventSource, 'addEventListener' | 'close' | 'onerror'>;
type Options = {
  onUpdate: () => void | Promise<unknown>;
  onConnection: (connected: boolean) => void;
  createSource?: (path: string) => Source;
};

export function watchUpdates(path: string, options: Options) {
  if (!route.test(path) || (!options.createSource && typeof EventSource === 'undefined')) {
    options.onConnection(false);
    return () => {};
  }
  const create = options.createSource ?? ((url: string) => new EventSource(url));
  let source: Source | undefined,
    stopped = false,
    generation = 0,
    attempt = 0,
    dirty = false,
    refreshing = false;
  let retry: ReturnType<typeof setTimeout> | undefined,
    watchdog: ReturnType<typeof setTimeout> | undefined,
    debounce: ReturnType<typeof setTimeout> | undefined;
  const refresh = () => {
    dirty = true;
    if (refreshing || debounce || stopped) return;
    debounce = setTimeout(() => {
      debounce = undefined;
      if (stopped) return;
      dirty = false;
      refreshing = true;
      Promise.resolve()
        .then(() => (stopped ? undefined : options.onUpdate()))
        .catch(() => {})
        .finally(() => {
          refreshing = false;
          if (dirty && !stopped) refresh();
        });
    }, 100);
  };
  const connect = () => {
    if (stopped) return;
    const current = ++generation;
    let ready = false;
    const lost = () => {
      if (stopped || generation !== current) return;
      generation++;
      source?.close();
      source = undefined;
      clearTimeout(watchdog);
      options.onConnection(false);
      const delay =
        Math.min(10000, 1000 * 2 ** Math.min(attempt++, 4)) + Math.floor(Math.random() * 250);
      retry = setTimeout(connect, delay);
    };
    const alive = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(lost, 20000);
    };
    try {
      source = create(path);
      options.onConnection(false);
      alive();
      source.onerror = lost;
      source.addEventListener('update', (event) => {
        if (stopped || current !== generation) return;
        try {
          const result = frame.parse(JSON.parse((event as MessageEvent<string>).data));
          if (!ready && result.kind !== 'ready') return lost();
          alive();
          if (result.kind === 'ready') {
            ready = true;
            attempt = 0;
            options.onConnection(true);
            refresh();
          } else if (result.kind === 'changed') refresh();
        } catch {
          lost();
        }
      });
    } catch {
      lost();
    }
  };
  connect();
  return () => {
    stopped = true;
    generation++;
    source?.close();
    clearTimeout(retry);
    clearTimeout(watchdog);
    clearTimeout(debounce);
  };
}
