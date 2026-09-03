import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { chromium } from '@playwright/test';
import { createApplication } from '@eventflow/service-runtime';
import { AppModule } from '../dist/app.module.js';
import { readAuthConfig } from '../dist/auth/config.js';
import { AuthService } from '../dist/auth/auth.service.js';
import { SessionStore } from '../dist/auth/session-store.js';

const config = readAuthConfig({ ...process.env, SESSION_PREFIX: `test:${randomUUID()}:` });
const origin = config.PUBLIC_ORIGIN;
const users = JSON.parse(readFileSync('work/local/demo-users.json', 'utf8'));
let app, browser, auth, store;
before(async () => {
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
