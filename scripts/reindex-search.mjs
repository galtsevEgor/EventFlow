import { ClientCredentials } from '../packages/service-runtime/dist/index.js';
if (process.argv.length !== 2) throw new Error('Use pnpm search:reindex');
const target = new URL(process.env.SEARCH_URL ?? 'http://127.0.0.1:4005');
if (
  target.protocol !== 'http:' ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  target.username ||
  target.password
)
  throw new Error('Search maintenance is restricted to local loopback');
const credentials = new ClientCredentials(
  process.env.OIDC_ISSUER,
  'eventflow-search',
  process.env.SEARCH_CLIENT_SECRET,
);
const response = await fetch(new URL('/internal/search/reindex', target), {
  method: 'POST',
  redirect: 'error',
  signal: AbortSignal.timeout(600000),
  headers: {
    authorization: 'Bearer ' + (await credentials.token()),
    'content-type': 'application/json',
  },
  body: '{}',
});
if (!response.ok) {
  await response.body?.cancel();
  throw new Error('Local search rebuild failed (' + response.status + ')');
}
const result = await response.json();
console.log(
  JSON.stringify({
    kind: 'search_rebuilt',
    index: result.index,
    position: result.position,
    completedAt: result.completedAt,
  }),
);
