import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { generateKeyPair } from 'jose';
import { catalogFixture } from './fixture.mjs';

let fixture;
before(async () => {
  fixture = await catalogFixture();
});
after(async () => {
  await fixture?.close();
});

test('creation is atomic with Owner membership and audit; another tenant sees 404', async () => {
  const owner = await fixture.token();
  const created = await fixture.request('/api/v1/organizations', owner, 'POST', {
    name: 'Первая организация',
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.role, 'OWNER');
  const id = created.body.id;
  assert.equal(
    await fixture.db.membership.count({ where: { organizationId: id, role: 'OWNER' } }),
    1,
  );
  const outsider = await fixture.token({ sub: 'another-user', email: 'outside@eventflow.test' });
  for (const method of ['GET', 'PATCH']) {
    const result = await fixture.request(
      `/api/v1/organizations/${id}`,
      outsider,
      method,
      method === 'PATCH' ? { name: 'Подмена' } : undefined,
      { 'x-user-id': 'test-owner', 'x-role': 'OWNER' },
    );
    assert.equal(result.status, 404);
  }
  assert.equal(
    (await fixture.request(`/api/v1/organizations/${id}`, owner)).body.name,
    'Первая организация',
  );
  assert.equal(
    (await fixture.request('/api/v1/organizations', outsider)).body.organizations.length,
    0,
  );
  const audit = await fixture.request(`/api/v1/organizations/${id}/audit`, owner);
  assert.equal(audit.body.entries[0].action, 'organization.created');
});

test('forged, expired, wrong audience and machine tokens never authorize user mutations', async () => {
  const otherKey = await generateKeyPair('RS256');
  const tokens = [
    undefined,
    'forged',
    await fixture.token({}, otherKey.privateKey),
    await fixture.token({ exp: 1 }),
    await fixture.token({ aud: 'wrong' }),
    await fixture.token({ iss: 'https://wrong.test' }),
    await fixture.token({ azp: 'eventflow-policy' }),
  ];
  for (const token of tokens) {
    const result = await fixture.request('/api/v1/organizations', token, 'POST', {
      name: 'Forbidden',
    });
    assert.equal(result.status, 401);
    assert.equal(result.body.code, 'UNAUTHENTICATED');
    assert.ok(result.body.requestId);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.ok(!JSON.stringify(result.body).includes('stack'));
  }
});

test('input validation and email verification fail before changing the database', async () => {
  const owner = await fixture.token();
  const invalid = await fixture.request('/api/v1/organizations', owner, 'POST', {
    name: 'a',
    role: 'OWNER',
  });
  assert.equal(invalid.status, 422);
  assert.ok(invalid.body.fieldErrors);
  const unverified = await fixture.request(
    '/api/v1/organizations',
    await fixture.token({ email_verified: false }),
    'POST',
    { name: 'Unverified' },
  );
  assert.equal(unverified.status, 403);
});

test('concurrent creation respects the per-account sandbox limit', async () => {
  const token = await fixture.token({ sub: 'limited-owner' });
  for (let index = 0; index < 4; index++)
    assert.equal(
      (
        await fixture.request('/api/v1/organizations', token, 'POST', {
          name: `Organization ${index}`,
        })
      ).status,
      201,
    );
  const results = await Promise.all(
    [1, 2].map((index) =>
      fixture.request('/api/v1/organizations', token, 'POST', { name: `Concurrent ${index}` }),
    ),
  );
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 409]);
  assert.equal(
    (await fixture.request('/api/v1/organizations', token)).body.organizations.length,
    5,
  );
});
