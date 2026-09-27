import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { chromium } from '@playwright/test';
import { createApplication, TokenVerifier } from '@eventflow/service-runtime';
import { AppModule } from '../dist/app.module.js';
import { readAuthConfig } from '../dist/auth/config.js';
import { AuthService } from '../dist/auth/auth.service.js';
import { SessionStore } from '../dist/auth/session-store.js';
import { cleanBroker } from '../../../tests/helpers/broker.mjs';

const config = readAuthConfig({
  ...process.env,
  SESSION_PREFIX: `test:${randomUUID()}:`,
  MESSAGE_NAMESPACE: `eventflow-test-${randomUUID()}`,
});
const origin = config.PUBLIC_ORIGIN;
const users = JSON.parse(readFileSync('work/local/demo-users.json', 'utf8'));
process.env.EVENTFLOW_LOG_REQUESTS = '0';
let app, browser, auth, store, upstream;
const forwarded = [];
let upstreamStatus = 200;
before(async () => {
  upstream = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    forwarded.push({ headers: request.headers, method: request.method, body });
    response.statusCode = upstreamStatus;
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify(
        upstreamStatus === 200 ? { organizations: [] } : { stack: 'private upstream details' },
      ),
    );
  });
  await new Promise((done) => upstream.listen(0, '127.0.0.1', done));
  config.CATALOG_URL = `http://127.0.0.1:${upstream.address().port}`;
  app = await createApplication(AppModule.configure(config));
  app.useLogger(false);
  await app.listen(Number(new URL(origin).port), '127.0.0.1');
  auth = app.get(AuthService);
  store = app.get(SessionStore);
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  if (store?.client.isReady) {
    for await (const keys of store.client.scanIterator({ MATCH: `${config.SESSION_PREFIX}*` }))
      if (keys.length) await store.client.del(keys);
  }
  await app?.close();
  await cleanBroker(config.MESSAGE_NAMESPACE);
  await new Promise((done) => upstream.close(done));
});

async function login(context, alias = 'owner') {
  const user = users.find((user) => user.username === alias);
  const page = await context.newPage();
  await page.goto(`${origin}/api/v1/auth/login?returnTo=/organizer/`);
  await page.locator('input[name="username"]').fill(user.email);
  await page.locator('input[name="password"]').fill(user.password);
  await page.locator('#kc-login').click();
  await page.waitForURL(`${origin}/organizer/`, { timeout: 15000 });
  await page.close();
  return (await context.request.get(`${origin}/api/v1/auth/session`)).json();
}

test('real Keycloak login yields only public identity and rejects CSRF before logout', async () => {
  const context = await browser.newContext();
  try {
    const session = await login(context);
    assert.equal(session.user.email, 'owner@eventflow.test');
    assert.equal(session.user.emailVerified, true);
    assert.deepEqual(Object.keys(session).sort(), ['csrfToken', 'user']);
    assert.ok(!JSON.stringify(session).includes('access_token'));
    const cookies = await context.cookies(origin);
    const cookie = cookies.find((cookie) => cookie.name === 'eventflow_session');
    assert.ok(cookie?.httpOnly);
    assert.equal(cookie.sameSite, 'Lax');
    const missingCsrf = await context.request.post(`${origin}/api/v1/auth/logout`, {
      headers: { origin },
    });
    assert.equal(missingCsrf.status(), 403);
    const wrongOrigin = await context.request.post(`${origin}/api/v1/auth/logout`, {
      headers: { origin: 'https://evil.test', 'x-csrf-token': session.csrfToken },
    });
    assert.equal(wrongOrigin.status(), 403);
    const loggedOut = await context.request.post(`${origin}/api/v1/auth/logout`, {
      headers: { origin, 'x-csrf-token': session.csrfToken },
    });
    assert.equal(loggedOut.status(), 200);
    assert.ok(!(await loggedOut.text()).includes('id_token_hint'));
    const replay = await context.request.get(`${origin}/api/v1/auth/session`, {
      headers: { cookie: `${cookie.name}=${cookie.value}` },
    });
    assert.deepEqual(await replay.json(), { user: null });
  } finally {
    await context.close();
  }
});

test('login state is browser-bound and consumed once on an invalid callback', async () => {
  const context = await browser.newContext();
  try {
    await context.request.get(`${origin}/api/v1/auth/login`, { maxRedirects: 0 });
    const response = await context.request.get(
      `${origin}/api/v1/auth/callback?code=forged&state=wrong`,
    );
    assert.equal(response.status(), 400);
    const body = await response.json();
    assert.equal(body.code, 'LOGIN_FAILED');
    assert.ok(body.requestId);
    assert.ok(!JSON.stringify(body).includes('stack'));
    const replay = await context.request.get(
      `${origin}/api/v1/auth/callback?code=forged&state=wrong`,
    );
    assert.equal((await replay.json()).code, 'LOGIN_EXPIRED');
  } finally {
    await context.close();
  }
});

test('concurrent refresh uses one rotated token and logout cannot resurrect a session', async () => {
  const context = await browser.newContext();
  try {
    await login(context, 'manager');
    const cookie = (await context.cookies(origin)).find(
      (cookie) => cookie.name === 'eventflow_session',
    );
    const before = await store.read(cookie.value);
    const expired = { ...before.session, accessExpiresAt: Date.now() - 1 };
    assert.equal(await store.replace(cookie.value, before.raw, expired), true);
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => context.request.get(`${origin}/api/v1/auth/session`)),
    );
    for (const response of responses) {
      assert.equal(response.status(), 200);
      assert.equal((await response.json()).user.sub, before.session.user.sub);
    }
    const current = await store.read(cookie.value);
    assert.notEqual(current.session.refreshToken, before.session.refreshToken);
    await store.destroy(cookie.value);
    assert.equal(await store.replace(cookie.value, current.raw, current.session), false);
    assert.equal(await store.read(cookie.value), null);
  } finally {
    await context.close();
  }
});

test('real machine token carries the required Catalog audience and policy permission', async () => {
  const response = await fetch(`${config.OIDC_ISSUER}/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'eventflow-policy',
      client_secret: process.env.POLICY_CLIENT_SECRET,
    }),
  });
  assert.equal(response.status, 200);
  const { access_token: token } = await response.json();
  const machine = await new TokenVerifier(config.OIDC_ISSUER, 'eventflow-catalog').machine(
    `Bearer ${token}`,
  );
  assert.ok(machine.subject);
});

test('proxy permits only public routes and replaces browser identity headers with a verified token', async () => {
  const context = await browser.newContext();
  try {
    const session = await login(context, 'outsider');
    const requestId = randomUUID();
    const response = await context.request.get(`${origin}/api/v1/organizations`, {
      headers: {
        authorization: 'Bearer forged',
        'x-user-id': 'owner',
        'x-role': 'OWNER',
        'x-request-id': requestId,
      },
    });
    assert.equal(response.status(), 200);
    const request = forwarded.at(-1);
    assert.equal(request.headers['x-user-id'], undefined);
    assert.equal(request.headers['x-role'], undefined);
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers['x-request-id'], requestId);
    const payload = JSON.parse(
      Buffer.from(
        request.headers.authorization.split(' ')[1].split('.')[1],
        'base64url',
      ).toString(),
    );
    assert.ok(
      [payload.aud].flat().includes('eventflow-catalog'),
      `Missing Catalog audience; received ${JSON.stringify(payload.aud)}`,
    );
    const jwtHeader = JSON.parse(
      Buffer.from(
        request.headers.authorization.split(' ')[1].split('.')[0],
        'base64url',
      ).toString(),
    );
    assert.equal(jwtHeader.alg, 'RS256');
    assert.equal(payload.iss, config.OIDC_ISSUER);
    assert.equal(typeof payload.iat, 'number');
    assert.equal(typeof payload.sub, 'string');
    assert.ok(payload.exp > Date.now() / 1000, 'Access token has expired');
    const user = await new TokenVerifier(config.OIDC_ISSUER, 'eventflow-catalog').user(
      request.headers.authorization,
    );
    assert.equal(user.email, 'outsider@eventflow.test');
    const count = forwarded.length;
    assert.equal(
      (
        await context.request.post(`${origin}/api/v1/organizations`, { data: { name: 'Denied' } })
      ).status(),
      403,
    );
    assert.equal((await context.request.post(`${origin}/internal/policy/check`)).status(), 404);
    assert.equal((await context.request.delete(`${origin}/api/v1/organizations`)).status(), 404);
    assert.equal(forwarded.length, count);
    const write = await context.request.post(`${origin}/api/v1/organizations`, {
      headers: { origin, 'x-csrf-token': session.csrfToken },
      data: { name: 'Allowed' },
    });
    assert.equal(write.status(), 200);
    assert.deepEqual(JSON.parse(forwarded.at(-1).body), { name: 'Allowed' });
    upstreamStatus = 500;
    const unavailable = await context.request.get(`${origin}/api/v1/organizations`);
    assert.equal(unavailable.status(), 503);
    assert.ok(!(await unavailable.text()).includes('private upstream'));
  } finally {
    upstreamStatus = 200;
    await context.close();
  }
});

test('expired server session is rejected; Redis failure returns 503 without identity', async () => {
  const context = await browser.newContext();
  try {
    const id = await store.create({
      user: { sub: 'test', email: 'test@eventflow.test', emailVerified: true, name: 'Test' },
      accessToken: 'unused',
      refreshToken: 'unused',
      idToken: 'unused',
      csrf: 'x'.repeat(43),
      accessExpiresAt: 0,
      absoluteExpiresAt: 0,
    });
    const expired = await context.request.get(`${origin}/api/v1/auth/session`, {
      headers: { cookie: `eventflow_session=${id}` },
    });
    assert.deepEqual(await expired.json(), { user: null });
    store.client.destroy();
    assert.equal((await context.request.get(`${origin}/health/ready`)).status(), 503);
    assert.equal((await context.request.get(`${origin}/health/live`)).status(), 200);
    const failed = await context.request.get(`${origin}/api/v1/auth/session`, {
      headers: { cookie: `eventflow_session=${id}` },
    });
    assert.equal(failed.status(), 503);
    assert.equal((await failed.json()).code, 'SESSION_UNAVAILABLE');
    await store.client.connect();
    assert.equal(auth.config.PUBLIC_ORIGIN, origin);
  } finally {
    await context.close();
  }
});
