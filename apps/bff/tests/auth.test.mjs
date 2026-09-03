import assert from 'node:assert/strict';
import test from 'node:test';
import { readAuthConfig, safeReturnTo } from '../dist/auth/config.js';
import { AuthService } from '../dist/auth/auth.service.js';

const config = {
  PUBLIC_ORIGIN: 'http://127.0.0.1:18000',
  OIDC_ISSUER: 'http://127.0.0.1:18080/realms/eventflow',
  OIDC_CLIENT_ID: 'client',
  OIDC_CLIENT_SECRET: 'x'.repeat(32),
  REDIS_URL: 'redis://localhost:6379',
  CATALOG_URL: 'http://127.0.0.1:4001',
};

test('returnTo permits internal pages and rejects external, encoded and API redirect targets', () => {
  assert.equal(safeReturnTo('/organizer/?tab=members'), '/organizer/?tab=members');
  for (const value of [
    'https://evil.test',
    '//evil.test',
    '/\\evil.test',
    '/%2f%2fevil.test',
    '/%5cevil.test',
    '/\n/evil.test',
    '/api/v1/auth/login',
    '/x/../api/v1/auth/login',
    '%',
    undefined,
  ]) {
    assert.equal(safeReturnTo(value), '/organizer/');
  }
});
test('configuration forbids cleartext nonlocal identity and production origins', () => {
  assert.equal(readAuthConfig(config).secure, false);
  assert.throws(() => readAuthConfig({ ...config, PUBLIC_ORIGIN: 'http://example.test' }));
  assert.throws(() => readAuthConfig({ ...config, NODE_ENV: 'production' }));
  assert.throws(() => readAuthConfig({ ...config, PUBLIC_ORIGIN: 'http://127.0.0.1:18000/extra' }));
});
test('mutations require both the session token and exact Origin', () => {
  const service = new AuthService(readAuthConfig(config), null, null);
  const token = 'a'.repeat(43);
  const request = (origin, csrf) => ({
    header: (name) => ({ origin, 'x-csrf-token': csrf })[name],
  });
  assert.doesNotThrow(() => service.assertCsrf(request(config.PUBLIC_ORIGIN, token), token));
  for (const requestValue of [
    request(undefined, token),
    request('https://evil.test', token),
    request(config.PUBLIC_ORIGIN, ''),
    request(config.PUBLIC_ORIGIN, 'b'.repeat(43)),
  ]) {
    assert.throws(
      () => service.assertCsrf(requestValue, token),
      (error) => error.getStatus() === 403,
    );
  }
});
test('HTTPS sessions use host-only Secure HttpOnly cookies', () => {
  const service = new AuthService({ ...readAuthConfig(config), secure: true }, null, null);
  const cookie = service.cookie('session', 'a'.repeat(43), 1800);
  for (const part of ['__Host-eventflow_session=', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax'])
    assert.ok(cookie.includes(part));
  assert.ok(!cookie.includes('Domain='));
});
