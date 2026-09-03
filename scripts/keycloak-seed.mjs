import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clientConfigurations, realmConfiguration, realmName } from '../infra/keycloak/config.mjs';

export async function seedKeycloak(env, directory = process.cwd()) {
  const base = new URL(env.KEYCLOAK_URL);
  const origin = new URL(env.PUBLIC_ORIGIN);
  if (
    ![base, origin].every(
      (url) => url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname),
    )
  ) {
    throw new Error('This development seed is restricted to loopback HTTP endpoints.');
  }
  for (const name of [
    'KEYCLOAK_ADMIN_PASSWORD',
    'OIDC_CLIENT_ID',
    'OIDC_CLIENT_SECRET',
    'POLICY_CLIENT_SECRET',
  ]) {
    if (!env[name]) throw new Error(`Missing ${name}; run pnpm env:init`);
  }
  const response = await fetch(`${base.origin}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
    body: new URLSearchParams({
      client_id: 'admin-cli',
      grant_type: 'password',
      username: 'admin',
      password: env.KEYCLOAK_ADMIN_PASSWORD,
    }),
  });
  if (!response.ok)
    throw new Error(`Keycloak bootstrap authentication failed: HTTP ${response.status}`);
  const { access_token: token } = await response.json();
  async function admin(path, method = 'GET', body, allowMissing = false) {
    const result = await fetch(`${base.origin}/admin/realms${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    });
    if (allowMissing && result.status === 404) return null;
    if (!result.ok)
      throw new Error(
        `Keycloak configuration request failed: ${method} ${path} HTTP ${result.status}`,
      );
    return result.status === 204 || result.status === 201 ? null : result.json();
  }
  const current = await admin(`/${realmName}`, 'GET', undefined, true);
  await admin(current ? `/${realmName}` : '', current ? 'PUT' : 'POST', realmConfiguration());
  for (const configuration of clientConfigurations(env)) {
    const [client] = await admin(`/${realmName}/clients?clientId=${configuration.clientId}`);
    await admin(
      client ? `/${realmName}/clients/${client.id}` : `/${realmName}/clients`,
      client ? 'PUT' : 'POST',
      configuration,
    );
  }
  let role = await admin(`/${realmName}/roles/policy-check`, 'GET', undefined, true);
  if (!role) {
    await admin(`/${realmName}/roles`, 'POST', { name: 'policy-check' });
    role = await admin(`/${realmName}/roles/policy-check`);
  }
  const [policyClient] = await admin(`/${realmName}/clients?clientId=eventflow-policy`);
  const serviceUser = await admin(`/${realmName}/clients/${policyClient.id}/service-account-user`);
  await admin(`/${realmName}/users/${serviceUser.id}/role-mappings/realm`, 'POST', [role]);

  const path = resolve(directory, 'work/local/demo-users.json');
  mkdirSync(resolve(directory, 'work/local'), { recursive: true });
  const users = existsSync(path)
    ? JSON.parse(readFileSync(path, 'utf8'))
    : ['owner', 'manager', 'staff', 'outsider'].map((name) => ({
        username: name,
        email: `${name}@eventflow.test`,
        password: randomBytes(18).toString('base64url'),
      }));
  // Persist generated credentials before requests so an interrupted seed can be resumed.
  writeFileSync(path, JSON.stringify(users, null, 2) + '\n', { mode: 0o600 });
  for (const user of users) {
    const [existing] = await admin(
      `/${realmName}/users?email=${encodeURIComponent(user.email)}&exact=true`,
    );
    if (!existing)
      await admin(`/${realmName}/users`, 'POST', {
        username: user.email,
        email: user.email,
        emailVerified: true,
        enabled: true,
        firstName: user.username,
        lastName: 'Demo',
        requiredActions: [],
        credentials: [{ type: 'password', value: user.password, temporary: false }],
      });
  }
  console.log(
    'Keycloak eventflow realm is ready. Local demo credentials: work/local/demo-users.json',
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await seedKeycloak(process.env);
