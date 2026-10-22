import { browserAnalyticsSchema, type BrowserAnalyticsEvent } from '@eventflow/event-contracts';
export function restoreAnalyticsQueue(input: unknown, now: number): BrowserAnalyticsEvent[] {
  if (!Array.isArray(input)) return [];
  return input
    .flatMap((value) => {
      const parsed = browserAnalyticsSchema.safeParse(value);
      return parsed.success &&
        now - Date.parse(parsed.data.occurredAt) < 23 * 3600000 &&
        Date.parse(parsed.data.occurredAt) <= now + 60000
        ? [parsed.data]
        : [];
    })
    .slice(-100);
}
export function analyticsBatch(queue: BrowserAnalyticsEvent[]): BrowserAnalyticsEvent[] {
  const result: BrowserAnalyticsEvent[] = [];
  for (const event of queue.slice(0, 30)) {
    if (new TextEncoder().encode(JSON.stringify({ events: [...result, event] })).length > 48000)
      break;
    result.push(event);
  }
  return result;
}
