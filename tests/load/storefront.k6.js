import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';

/* global __ENV */
const smoke = __ENV.PROFILE === 'smoke';
const origin = __ENV.EVENTFLOW_LOAD_ORIGIN;
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw new Error('Local fixture only');
const outcomes = {
  success: new Counter('successful_responses'),
  limited: new Counter('limited_responses'),
  busy: new Counter('busy_responses'),
  degraded: new Counter('degraded_pages'),
  unexpected: new Counter('unexpected_responses'),
};
const successfulLatency = new Trend('successful_latency', true);
export const options = {
  scenarios: {
    api: {
      executor: 'constant-arrival-rate',
      exec: 'api',
      rate: smoke ? 20 : 150,
      timeUnit: '1s',
      duration: smoke ? '10s' : '20s',
      preAllocatedVUs: 96,
      maxVUs: 96,
    },
    ssr: {
      executor: 'constant-arrival-rate',
      exec: 'ssr',
      rate: smoke ? 5 : 30,
      timeUnit: '1s',
      duration: smoke ? '10s' : '20s',
      preAllocatedVUs: 48,
      maxVUs: 48,
    },
  },
  summaryTrendStats: ['count', 'med', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    checks: ['rate==1'],
    unexpected_responses: ['count==0'],
    dropped_iterations: ['count==0'],
    ...(smoke
      ? {
          limited_responses: ['count==0'],
          busy_responses: ['count==0'],
          degraded_pages: ['count==0'],
        }
      : {}),
  },
};
function record(response, ssr) {
  const good =
    response.status === 200 &&
    (ssr
      ? response.body.includes('EF-111 synthetic event 11')
      : response.json('events')?.length === 12);
  const limited = response.status === 429 && Number(response.headers['Retry-After']) > 0;
  const busy = response.status === 503 && Number(response.headers['Retry-After']) > 0;
  const degraded =
    ssr && response.status === 200 && response.body.includes('Каталог временно недоступен');
  const valid = good || limited || busy || degraded;
  if (good) successfulLatency.add(response.timings.duration);
  outcomes.success.add(good ? 1 : 0);
  outcomes.limited.add(limited ? 1 : 0);
  outcomes.busy.add(busy ? 1 : 0);
  outcomes.degraded.add(degraded ? 1 : 0);
  outcomes.unexpected.add(valid ? 0 : 1);
  check(response, { 'response is successful or explicitly retryable': () => valid });
}
export function api() {
  record(http.get(origin + '/api/v1/events', { timeout: '8s' }), false);
}
export function ssr() {
  record(http.get(origin + '/', { timeout: '8s' }), true);
}
export function handleSummary(data) {
  return { [__ENV.RESULT]: JSON.stringify(data, null, 2) };
}
