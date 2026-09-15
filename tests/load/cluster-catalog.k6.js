import http from 'k6/http';
import { check } from 'k6';

/* global __ENV */
const smoke = __ENV.PROFILE === 'smoke';
const stages = (rates) =>
  (smoke ? rates.slice(0, 1) : rates).map((target) => ({
    target,
    duration: smoke ? '8s' : '20s',
  }));

export const options = {
  discardResponseBodies: true,
  summaryTrendStats: ['count', 'med', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    catalog: {
      executor: 'ramping-arrival-rate',
      exec: 'catalog',
      startRate: smoke ? 10 : 50,
      timeUnit: '1s',
      preAllocatedVUs: 32,
      maxVUs: 120,
      stages: stages(smoke ? [10] : [50, 150, 300]),
    },
    storefront: {
      executor: 'ramping-arrival-rate',
      exec: 'storefront',
      startRate: smoke ? 2 : 10,
      timeUnit: '1s',
      preAllocatedVUs: 16,
      maxVUs: 60,
      stages: stages(smoke ? [2] : [10, 30, 50]),
    },
  },
  thresholds: {
    'http_req_duration{scenario:catalog}': [],
    'http_req_duration{scenario:storefront}': [],
    'http_req_failed{scenario:catalog}': smoke ? ['rate<0.02'] : [],
    'http_req_failed{scenario:storefront}': smoke ? ['rate<0.02'] : [],
    checks: smoke ? ['rate>0.98'] : [],
    dropped_iterations: smoke ? ['count<2'] : [],
  },
};

const origin = 'http://127.0.0.1:58000';

export function catalog() {
  const response = http.get(origin + '/api/v1/events', { timeout: '5s' });
  check(response, {
    'catalog returns JSON': (r) =>
      r.status === 200 && /json/i.test(r.headers['Content-Type'] ?? ''),
  });
}

export function storefront() {
  const response = http.get(origin + '/', { timeout: '5s', responseType: 'text' });
  check(response, {
    'storefront renders': (r) => r.status === 200 && r.body?.includes('/_next/static/'),
  });
}

export function handleSummary(data) {
  return { [__ENV.RESULT]: JSON.stringify(data, null, 2) };
}
