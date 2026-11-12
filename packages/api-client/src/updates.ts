import { z } from 'zod';
import type { components } from './schema';

export const LIVE_QUERY_RECHECK_INTERVAL_MS = 30_000;
const LIVE_QUERY_FALLBACK_INTERVAL_MS = 5_000;
const UPDATE_DEBOUNCE_MS = 100;
const STREAM_IDLE_TIMEOUT_MS = 20_000;
const RECONNECT_INITIAL_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 10_000;
const RECONNECT_MAX_EXPONENT = 4;
const RECONNECT_JITTER_MS = 250;

export function liveQueryPollInterval(connected: boolean) {
  return connected ? LIVE_QUERY_RECHECK_INTERVAL_MS : LIVE_QUERY_FALLBACK_INTERVAL_MS;
}

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
    }, UPDATE_DEBOUNCE_MS);
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
        Math.min(
          RECONNECT_MAX_DELAY_MS,
          RECONNECT_INITIAL_DELAY_MS * 2 ** Math.min(attempt++, RECONNECT_MAX_EXPONENT),
        ) + Math.floor(Math.random() * RECONNECT_JITTER_MS);
      retry = setTimeout(connect, delay);
    };
    const alive = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(lost, STREAM_IDLE_TIMEOUT_MS);
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
