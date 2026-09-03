import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isCatalogRoute } from '../dist/catalog.routes.js';

test('public Catalog contract is covered by the allowlist', () => {
  const contract = JSON.parse(
    readFileSync(new URL('../../../services/catalog/openapi.json', import.meta.url), 'utf8'),
  );
  for (const [path, operations] of Object.entries(contract.paths)) {
    if (!path.startsWith('/api/v1/')) continue;
    const example = path
      .replaceAll('{user}', 'subject')
      .replace(/\{[^}]+\}/g, 'b8efbbd7-a6bf-42e1-93cb-e252d05e98b1');
    for (const method of Object.keys(operations))
      assert.ok(isCatalogRoute(method.toUpperCase(), example), `${method} ${path}`);
  }
});
test('internal policy, arbitrary proxies and unsupported verbs are never forwarded', () => {
  for (const path of [
    '/internal/policy/check',
    '/api/v1/internal/policy/check',
    '/api/v1/organizations/../../internal/policy/check',
    '/api/v1/organizations/http://evil.test',
    '/api/v1/auth/session',
  ]) {
    assert.equal(isCatalogRoute('POST', path), false);
  }
  assert.equal(isCatalogRoute('DELETE', '/api/v1/organizations'), false);
});
