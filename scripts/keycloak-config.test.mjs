import assert from 'node:assert/strict';
import test from 'node:test';
import { clientConfigurations, realmConfiguration } from '../infra/keycloak/config.mjs';

test('web client restricts redirects and requires PKCE without password or implicit grants', () => {
  const clients = clientConfigurations({
    PUBLIC_ORIGIN: 'http://127.0.0.1:18000',
    OIDC_CLIENT_ID: 'test',
  });
  const web = clients.find((client) => client.clientId === 'test');
  const machine = clients.find((client) => client.clientId === 'eventflow-policy');
  assert.deepEqual(web.redirectUris, ['http://127.0.0.1:18000/api/v1/auth/callback']);
  assert.equal(web.attributes['pkce.code.challenge.method'], 'S256');
  assert.equal(web.publicClient, false);
  assert.equal(web.directAccessGrantsEnabled, false);
  assert.equal(web.implicitFlowEnabled, false);
  assert.equal(web.serviceAccountsEnabled, false);
  assert.equal(machine.standardFlowEnabled, false);
  assert.equal(machine.serviceAccountsEnabled, true);
  assert.ok(web.defaultClientScopes.includes('basic'));
  assert.ok(machine.defaultClientScopes.includes('basic'));
  assert.equal(realmConfiguration().verifyEmail, true);
  assert.equal(realmConfiguration().revokeRefreshToken, true);
});

test('search service has no browser grants and receives only its Catalog/Search audiences', () => {
  const client = clientConfigurations({}).find((client) => client.clientId === 'eventflow-search');
  assert.equal(client.standardFlowEnabled, false);
  assert.equal(client.directAccessGrantsEnabled, false);
  assert.equal(client.serviceAccountsEnabled, true);
  assert.deepEqual(
    client.protocolMappers.map((mapper) => mapper.config['included.custom.audience']).sort(),
    ['eventflow-catalog', 'eventflow-search'],
  );
});
