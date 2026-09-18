import http from 'k6/http';
import { check } from 'k6';

/* global __ENV */
const smoke = __ENV.PROFILE === 'smoke';
const fault = __ENV.PROFILE === 'fault';
const bounded = smoke || fault;
const target = __ENV.EVENTFLOW_LOAD_TARGET || 'mixed';
const vuFactor = Number(__ENV.EVENTFLOW_LOAD_VU_FACTOR || 1);
if (!['catalog', 'storefront', 'mixed'].includes(target) || ![1, 2].includes(vuFactor))
  throw new Error('Invalid load target or VU multiplier');
const stages = (rates) =>
  (bounded ? rates.slice(0, 1) : rates).map((target) => ({
    target,
    duration: smoke ? '8s' : fault ? '30s' : '20s',
  }));

const scenarios = {
  catalog: {
    executor: 'ramping-arrival-rate',
    exec: 'catalog',
    startRate: smoke ? 10 : 50,
    timeUnit: '1s',
    preAllocatedVUs: vuFactor === 2 ? 240 : 32,
    maxVUs: 120 * vuFactor,
    stages: stages(smoke ? [10] : [50, 150, 300]),
  },
  storefront: {
    executor: 'ramping-arrival-rate',
    exec: 'storefront',
    startRate: smoke ? 2 : 10,
    timeUnit: '1s',
    preAllocatedVUs: vuFactor === 2 ? 120 : 16,
    maxVUs: 60 * vuFactor,
    stages: stages(smoke ? [2] : [10, 30, 50]),
  },
};
const selected = target === 'mixed' ? scenarios : { [target]: scenarios[target] };

export const options = {
  discardResponseBodies: true,
  summaryTrendStats: ['count', 'med', 'p(95)', 'p(99)', 'max'],
  scenarios: selected,
  thresholds: {
    ...Object.fromEntries(
      Object.keys(selected).flatMap((scenario) => [
        [`http_req_duration{scenario:${scenario}}`, []],
        [`http_req_failed{scenario:${scenario}}`, bounded ? ['rate<0.02'] : []],
        [`dropped_iterations{scenario:${scenario}}`, []],
        [`checks{scenario:${scenario}}`, []],
      ]),
    ),
    checks: bounded ? ['rate>0.98'] : [],
    dropped_iterations: bounded ? ['count<2'] : [],
  },
};

const origin = __ENV.EVENTFLOW_LOAD_ORIGIN || 'http://127.0.0.1:58000';
if (!/^http:\/\/(127\.0\.0\.1:58000|10\.43\.\d{1,3}\.\d{1,3}:(3000|4000|4001))$/.test(origin))
  throw new Error('Use the local k3d gateway or a service in the local cluster');

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
    'storefront renders the catalog': (r) =>
      r.status === 200 && r.body?.includes('Ближайшие мероприятия'),
  });
}

export function handleSummary(data) {
  return { [__ENV.RESULT]: JSON.stringify(data, null, 2) };
}
