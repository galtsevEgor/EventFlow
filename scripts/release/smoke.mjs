import assert from 'node:assert/strict';

const origin = process.env.PUBLIC_ORIGIN;
const issuer = process.env.OIDC_ISSUER;
async function request(url) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 200, new URL(url).pathname);
  return response;
}
async function verify(url, text) {
  assert.ok((await (await request(url)).text()).includes(text), new URL(url).pathname);
}
await Promise.all([
  ...[4000, 4001, 4002, 4003, 4004].map(async (port) => {
    const response = await request(`http://127.0.0.1:${port}/health/ready`);
    assert.equal((await response.json()).status, 'ok');
  }),
  verify(origin, 'EventFlow'),
  verify(origin + '/organizer/', '/organizer/assets/'),
  (async () => {
    const response = await request(origin + '/api/v1/events');
    assert.ok(Array.isArray((await response.json()).events));
  })(),
  (async () => {
    const response = await request(origin + '/api/v1/auth/session');
    assert.deepEqual(await response.json(), { user: null });
  })(),
  (async () => {
    const response = await request(issuer + '/.well-known/openid-configuration');
    assert.equal((await response.json()).issuer, issuer);
  })(),
]);
