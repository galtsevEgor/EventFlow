import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';
import { SharedArray } from 'k6/data';
import { Counter, Trend } from 'k6/metrics';

/* global __ENV */
const fixture = JSON.parse(open(__ENV.EVENTFLOW_LOAD_FIXTURE));
const tokens = new SharedArray('synthetic buyers', () =>
  JSON.parse(open(__ENV.EVENTFLOW_LOAD_TOKENS)),
);
const reserveDuration = new Trend('reserve_ms', true),
  catalogDuration = new Trend('catalog_ms', true);
const accepted = new Counter('reservations_accepted'),
  conflicts = new Counter('reservation_conflicts');
export const options = {
  summaryTrendStats: ['min', 'med', 'p(95)', 'p(99)', 'max'],
  scenarios: {
    catalog: {
      executor: 'constant-arrival-rate',
      exec: 'catalog',
      rate: 50,
      timeUnit: '1s',
      duration: `${fixture.duration}s`,
      preAllocatedVUs: 100,
      maxVUs: 100,
    },
    reserve: {
      executor: 'constant-arrival-rate',
      exec: 'reserve',
      rate: 5,
      timeUnit: '1s',
      duration: `${fixture.duration}s`,
      preAllocatedVUs: 30,
      maxVUs: 100,
    },
  },
  thresholds: {
    checks: ['rate==1'],
    http_req_failed: ['rate==0'],
    dropped_iterations: ['count==0'],
    reservations_accepted: [`count>=${fixture.duration * 5}`],
  },
};
export function catalog() {
  const page = (exec.scenario.iterationInTest % Math.ceil(fixture.sales.length / 12)) + 1;
  const response = http.get(`${fixture.catalog}/api/v1/events?page=${page}`, {
    tags: { name: 'public_catalog' },
  });
  catalogDuration.add(response.timings.duration);
  check(response, {
    'catalog is available': (r) => r.status === 200 && r.json('total') === fixture.sales.length,
  });
}
export function reserve() {
  const i = exec.scenario.iterationInTest;
  const index = fixture.offset + Math.floor(i / fixture.sales.length);
  const saleId = fixture.sales[i % fixture.sales.length];
  const key = fixture.runId.slice(0, 24) + i.toString(16).padStart(12, '0');
  const response = http.post(
    `${fixture.booking}/api/v1/orders`,
    JSON.stringify({ saleId, seatIds: [`r${Math.floor(index / 50) + 1}-s${(index % 50) + 1}`] }),
    {
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${tokens[i]}`,
        'idempotency-key': key,
      },
      tags: { name: 'reserve' },
    },
  );
  reserveDuration.add(response.timings.duration);
  if (response.status === 201) accepted.add(1);
  if (response.status === 409) conflicts.add(1);
  check(response, {
    'reservation accepted': (r) => r.status === 201 && r.json('totalMinor') === 2500 + index,
  });
}
export function handleSummary(data) {
  return { [__ENV.EVENTFLOW_LOAD_SUMMARY]: JSON.stringify(data, null, 2) };
}
