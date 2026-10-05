import assert from 'node:assert/strict';
import { eventually } from './eventually.mjs';

export async function metricQuery(query) {
  const url = new URL('http://127.0.0.1:19090/api/v1/query');
  url.searchParams.set('query', query);
  const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'success');
  return body.data.result;
}
export function metricValue(query, accept = (value) => value > 0) {
  return eventually(
    async () => {
      const rows = await metricQuery(query);
      return rows.length ? Number(rows[0].value[1]) : undefined;
    },
    (value) => value !== undefined && accept(value),
    25000,
  );
}
