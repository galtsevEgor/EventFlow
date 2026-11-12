'use client';
import { analyticsBatch, restoreAnalyticsQueue } from './analytics-queue';
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import type { BrowserAnalyticsEvent as Event } from '@eventflow/event-contracts';

const ANALYTICS_FLUSH_INTERVAL_MS = 4_000;

const storageKey = 'eventflow.analytics.queue.v1';
let queue: Event[] = [];
let enabled = false,
  offset = 0,
  busy = false;
let initialized = false;
function persist() {
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(queue));
  } catch {
    /* Collection never blocks shopping. */
  }
}
async function flush() {
  if (!enabled || busy || !queue.length) return;
  busy = true;
  const batch = analyticsBatch(queue);
  try {
    const result = await fetch('/api/v1/analytics/events', {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events: batch }),
    });
    if (result.ok || [409, 422].includes(result.status)) {
      const ids = new Set(batch.map((e) => e.id));
      queue = queue.filter((e) => !ids.has(e.id));
      persist();
    }
  } catch {
    /* Keep stable IDs for the next retry, including reload after a lost ACK. */
  } finally {
    busy = false;
  }
}
function track(event: Omit<Event, 'id' | 'occurredAt'>) {
  if (!enabled || document.visibilityState !== 'visible') return;
  queue.push({
    ...event,
    id: crypto.randomUUID(),
    occurredAt: new Date(Date.now() + offset).toISOString(),
  });
  queue = queue.slice(-100);
  persist();
  void flush();
}
export function AnalyticsCollector() {
  const pathname = usePathname();
  useEffect(() => {
    let stopped = false;
    let observer: IntersectionObserver | undefined;
    let mutations: MutationObserver | undefined;
    const seen = new Set<string>();
    function click(event: MouseEvent) {
      const target =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-analytics-event]')
          : null;
      const root = target?.closest<HTMLElement>('[data-search-proof]');
      const proof = root?.dataset.searchProof;
      if (target?.dataset.analyticsEvent && proof)
        track({
          kind: 'search_click',
          eventId: target.dataset.analyticsEvent,
          source: 'search',
          searchProof: proof,
        });
    }
    async function setup() {
      try {
        const result = await fetch('/api/v1/analytics/context', {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!result.ok) return;
        const data = (await result.json()) as { enabled: boolean; serverTime: number };
        if (stopped) return;
        enabled = data.enabled;
        offset = data.serverTime - Date.now();
        if (!enabled) return;
        if (!initialized) {
          initialized = true;
          try {
            queue = restoreAnalyticsQueue(
              JSON.parse(sessionStorage.getItem(storageKey) ?? '[]'),
              Date.now(),
            );
          } catch {
            queue = [];
          }
        }
        const detail = pathname.match(/^\/events\/([a-f0-9-]{36})$/);
        if (detail?.[1]) {
          track({ kind: 'impression', eventId: detail[1], source: 'direct' });
          track({ kind: 'event_view', eventId: detail[1], source: 'direct' });
        }
        observer = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const card = entry.target as HTMLElement,
                id = card.dataset.analyticsEvent;
              if (
                !id ||
                !entry.isIntersecting ||
                entry.intersectionRatio < 0.5 ||
                seen.has(
                  (card.closest<HTMLElement>('[data-search-proof]')?.dataset.searchProof ??
                    'catalog') + id,
                ) ||
                document.visibilityState !== 'visible'
              )
                continue;
              seen.add(
                (card.closest<HTMLElement>('[data-search-proof]')?.dataset.searchProof ??
                  'catalog') + id,
              );
              const proof = card.closest<HTMLElement>('[data-search-proof]')?.dataset.searchProof;
              track({
                kind: 'impression',
                eventId: id,
                source: proof ? 'search' : 'catalog',
                ...(proof ? { searchProof: proof } : {}),
              });
            }
          },
          { threshold: 0.5 },
        );
        const observe = () =>
          document
            .querySelectorAll('[data-analytics-event]')
            .forEach((card) => observer!.observe(card));
        observe();
        mutations = new MutationObserver(observe);
        mutations.observe(document.body, { childList: true, subtree: true });
        void flush();
      } catch {
        /* Optional analytics stays independent from catalog/booking. */
      }
    }
    void setup();
    document.addEventListener('click', click, true);
    const timer = setInterval(() => void flush(), ANALYTICS_FLUSH_INTERVAL_MS);
    const hide = () => void flush();
    window.addEventListener('pagehide', hide);
    return () => {
      stopped = true;
      observer?.disconnect();
      mutations?.disconnect();
      clearInterval(timer);
      document.removeEventListener('click', click, true);
      window.removeEventListener('pagehide', hide);
    };
  }, [pathname]);
  return null;
}
