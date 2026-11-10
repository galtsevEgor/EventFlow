import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isCatalogRoute, isOrganizerOrderRoute } from '../dist/catalog.routes.js';
import { orderRoute } from '../dist/orders.routes.js';

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

test('organizer orders expose only list and full-refund mutations', () => {
  const id = 'b8efbbd7-a6bf-42e1-93cb-e252d05e98b1';
  const path = `/api/v1/organizations/${id}/events/${id}/orders`;
  assert.ok(isOrganizerOrderRoute('GET', path));
  assert.ok(isOrganizerOrderRoute('POST', `${path}/${id}/refund`));
  for (const [method, suffix] of [
    ['POST', ''],
    ['DELETE', `/${id}/refund`],
    ['GET', `/${id}/refund`],
    ['POST', `/${id}/refund/retry`],
  ])
    assert.equal(isOrganizerOrderRoute(method, path + suffix), false);
});

test('buyer order routes classify only their original methods, paths and response kinds', () => {
  const orders = '/api/v1/orders';
  const id = 'b8efbbd7-a6bf-42e1-93cb-e252d05e98b1';
  const order = `${orders}/${id}`;
  const routes = [
    ['GET', orders, { service: 'BOOKING' }],
    ['POST', orders, { service: 'BOOKING', reserve: true }],
    ['GET', order, { service: 'BOOKING' }],
    ['POST', `${order}/cancel`, { service: 'BOOKING' }],
    ['GET', `${order}/payment-status`, { service: 'PAYMENTS' }],
    ['POST', `${order}/payment-attempt`, { service: 'PAYMENTS' }],
    ['POST', `${order}/payment-attempt/fake-confirm`, { service: 'PAYMENTS' }],
    ['GET', `${order}/tickets`, { service: 'TICKETS' }],
    ['GET', `${order}/tickets/${id}/code`, { service: 'TICKETS' }],
    ['GET', `${order}/tickets/${id}/qr`, { service: 'TICKETS', png: true }],
  ];
  for (const [method, path, expected] of routes) {
    assert.deepEqual(orderRoute(method, path), expected);
    assert.equal(orderRoute(method, `https://attacker.test${path}`), undefined);
    assert.equal(orderRoute(method, `${path}/`), undefined);
    assert.equal(orderRoute('HEAD', path), undefined);
    assert.equal(orderRoute('PUT', path), undefined);
    if (path !== orders)
      assert.equal(orderRoute(method === 'GET' ? 'POST' : 'GET', path), undefined);
  }
  for (const path of [
    `${orders}/${id.toUpperCase()}`,
    `${order}/updates`,
    `${order}/tickets/%2e%2e`,
  ])
    assert.equal(orderRoute('GET', path), undefined);
});
