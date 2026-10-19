import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import execution from 'k6/execution';
/* global __ENV */
const cases = JSON.parse(__ENV.SEARCH_CASES),
  smoke = __ENV.PROFILE === 'smoke';
for (const key of ['SEARCH_ORIGIN', 'CATALOG_ORIGIN'])
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(__ENV[key])) throw new Error('Owned local fixtures only');
const errors = new Counter('search_errors'),
  sqlLatency = new Trend('sql_latency', true),
  searchLatency = new Trend('search_latency', true);
const scenario = (exec, startTime) => ({
  executor: 'constant-arrival-rate',
  exec,
  startTime,
  rate: __ENV.PROFILE === 'stress' ? 25 : 5,
  timeUnit: '1s',
  duration: smoke ? '5s' : '30s',
  preAllocatedVUs: 32,
  maxVUs: 32,
  gracefulStop: '5s',
});
export const options = {
  scenarios: { sql: scenario('sql', '0s'), search: scenario('search', smoke ? '7s' : '45s') },
  summaryTrendStats: ['count', 'med', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    checks: ['rate==1'],
    search_errors: ['count==0'],
    'search_errors{engine:sql}': ['count==0'],
    'search_errors{engine:search}': ['count==0'],
    dropped_iterations: ['count==0'],
  },
};
function request(origin, path, latency) {
  const fixture = cases[execution.scenario.iterationInTest % cases.length];
  const response = http.get(origin + path + '?' + fixture.query, { timeout: '8s' });
  let good = false;
  if (response.status === 200) {
    const page = response.json();
    good =
      page.total === fixture.total &&
      JSON.stringify(page.events.map((event) => event.id)) === JSON.stringify(fixture.ids);
  }
  errors.add(good ? 0 : 1, { engine: path.endsWith('/fallback') ? 'sql' : 'search' });
  latency.add(response.timings.duration);
  check(response, { 'exact total and stable result page': () => good });
}
export function sql() {
  request(__ENV.CATALOG_ORIGIN, '/api/v1/search/fallback', sqlLatency);
}
export function search() {
  request(__ENV.SEARCH_ORIGIN, '/api/v1/search/events', searchLatency);
}
export function handleSummary(data) {
  return { [__ENV.RESULT]: JSON.stringify(data, null, 2) };
}
