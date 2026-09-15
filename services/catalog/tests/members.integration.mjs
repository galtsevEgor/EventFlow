import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { requirePolicy } from '@eventflow/service-runtime';
import { catalogFixture } from './fixture.mjs';
import { receivedMail } from '../../../tests/helpers/mailpit.mjs';

let fixture, owner, organization;
before(async () => {
  fixture = await catalogFixture();
  owner = await fixture.token();
  const result = await fixture.request('/api/v1/organizations', owner, 'POST', {
    name: 'Команда EventFlow',
  });
  assert.equal(result.status, 201);
  organization = result.body.id;
});
after(async () => {
  await fixture?.close();
});
const orgPath = (suffix = '') => `/api/v1/organizations/${organization}${suffix}`;
async function invite(email, role) {
  const result = await fixture.request(orgPath('/invitations'), owner, 'POST', { email, role });
  assert.equal(result.status, 201);
  return result.body;
}
async function join(subject, role) {
  const email = `${subject}@eventflow.test`;
  const invitation = await invite(email, role);
  const token = await fixture.token({ sub: subject, email });
  assert.equal(
    (
      await fixture.request('/api/v1/invitations/accept', token, 'POST', {
        token: invitation.token,
      })
    ).status,
    200,
  );
  return token;
}

test('Catalog delivers its own invitation via Mailpit with an encrypted pending token', async () => {
  const address = `invite-${randomUUID()}@eventflow.test`;
  const invitation = await invite(address, 'STAFF');
  const pending = await fixture.db.invitation.findUnique({ where: { id: invitation.id } });
  assert.ok(
    pending.deliveryToken && !Buffer.from(pending.deliveryToken).includes(invitation.token),
  );
  const message = await receivedMail(`catalog-${invitation.id}@eventflow.test`);
  assert.ok(message.To.some(({ Address }) => Address === address));
  assert.ok(message.Text.includes(`/organizer/?invite=${invitation.token}`));
});

test('invitation is verified-email-bound and single-use under concurrency', async () => {
  const invitation = await invite('manager@eventflow.test', 'MANAGER');
  const wrongEmail = await fixture.request('/api/v1/invitations/accept', owner, 'POST', {
    token: invitation.token,
  });
  assert.equal(wrongEmail.status, 403);
  const unverified = await fixture.token({
    sub: 'manager',
    email: 'manager@eventflow.test',
    email_verified: false,
  });
  assert.equal(
    (
      await fixture.request('/api/v1/invitations/accept', unverified, 'POST', {
        token: invitation.token,
      })
    ).status,
    403,
  );
  const manager = await fixture.token({ sub: 'manager', email: 'manager@eventflow.test' });
  const results = await Promise.all(
    [1, 2].map(() =>
      fixture.request('/api/v1/invitations/accept', manager, 'POST', { token: invitation.token }),
    ),
  );
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal(
    await fixture.db.membership.count({
      where: { organizationId: organization, userSubject: 'manager' },
    }),
    1,
  );
  const stored = await fixture.db.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
  assert.ok(!JSON.stringify(stored).includes(invitation.token));
  const listing = await fixture.request(orgPath('/invitations'), owner);
  assert.ok(!JSON.stringify(listing.body).includes('tokenHash'));
});

test('Manager creates drafts but cannot manage participants or invite an Owner', async () => {
  const manager = await fixture.token({ sub: 'manager', email: 'manager@eventflow.test' });
  const created = await fixture.request(orgPath('/events'), manager, 'POST', {
    title: 'Первое мероприятие',
  });
  assert.equal(created.status, 201);
  assert.equal((await fixture.request(orgPath('/members'), manager)).status, 403);
  assert.equal(
    (
      await fixture.request(orgPath('/invitations'), manager, 'POST', {
        email: 'new@eventflow.test',
        role: 'STAFF',
      })
    ).status,
    403,
  );
  assert.equal(
    (await fixture.request(orgPath('/members/test-owner'), manager, 'PATCH', { role: 'STAFF' }))
      .status,
    403,
  );
  assert.equal(
    (
      await fixture.request(orgPath('/invitations'), owner, 'POST', {
        email: 'new@eventflow.test',
        role: 'OWNER',
      })
    ).status,
    422,
  );
  const outsider = await fixture.token({ sub: 'foreign' });
  assert.equal(
    (await fixture.request(orgPath(`/events/${created.body.id}`), outsider)).status,
    404,
  );
  assert.equal(
    (
      await fixture.request(orgPath(`/events/${created.body.id}`), outsider, 'PATCH', {
        title: 'Подмена',
      })
    ).status,
    404,
  );
});

test('expiry and revocation reject acceptance without creating membership', async () => {
  const expired = await invite('expired@eventflow.test', 'STAFF');
  await fixture.db.invitation.update({
    where: { id: expired.id },
    data: { expiresAt: new Date(0) },
  });
  const token = await fixture.token({ sub: 'expired', email: 'expired@eventflow.test' });
  assert.equal(
    (await fixture.request('/api/v1/invitations/accept', token, 'POST', { token: expired.token }))
      .status,
    409,
  );
  const revoked = await invite('revoked@eventflow.test', 'STAFF');
  assert.equal(
    (await fixture.request(orgPath(`/invitations/${revoked.id}`), owner, 'DELETE')).status,
    200,
  );
  const other = await fixture.token({ sub: 'revoked', email: 'revoked@eventflow.test' });
  assert.equal(
    (await fixture.request('/api/v1/invitations/accept', other, 'POST', { token: revoked.token }))
      .status,
    409,
  );
  assert.equal(
    await fixture.db.membership.count({ where: { userSubject: { in: ['expired', 'revoked'] } } }),
    0,
  );
});

test('staff access is limited to assignments; removal is visible on the next policy request', async () => {
  const staff = await join('staff', 'STAFF');
  const event = (
    await fixture.request(orgPath('/events'), owner, 'POST', { title: 'Вход по списку' })
  ).body;
  const machine = await fixture.token({
    sub: 'service',
    azp: 'eventflow-policy',
    realm_access: { roles: ['policy-check'] },
  });
  const query = {
    actorSubject: 'staff',
    organizationId: organization,
    eventId: event.id,
    action: 'check-in',
  };
  assert.equal((await fixture.request('/internal/policy/check', staff, 'POST', query)).status, 403);
  assert.equal((await fixture.request(orgPath('/events'), staff)).body.events.length, 0);
  assert.equal((await fixture.request(orgPath(`/events/${event.id}`), staff)).status, 404);
  assert.equal(
    (await fixture.request('/internal/policy/check', machine, 'POST', query)).body.allowed,
    false,
  );
  assert.equal(
    (
      await fixture.request(orgPath(`/members/staff/events/${event.id}`), owner, 'PUT', {
        assigned: true,
      })
    ).status,
    200,
  );
  await requirePolicy(fixture.origin, machine, query);
  assert.equal((await fixture.request(orgPath('/events'), staff)).body.events.length, 1);
  assert.equal(
    (await fixture.request(orgPath('/events'), staff, 'POST', { title: 'Запрещено' })).status,
    403,
  );
  const foreign = (
    await fixture.request('/api/v1/organizations', owner, 'POST', { name: 'Другая команда' })
  ).body;
  const foreignEvent = (
    await fixture.request(`/api/v1/organizations/${foreign.id}/events`, owner, 'POST', {
      title: 'Другое событие',
    })
  ).body;
  assert.equal(
    (
      await fixture.request(orgPath(`/members/staff/events/${foreignEvent.id}`), owner, 'PUT', {
        assigned: true,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await fixture.request('/internal/policy/check', machine, 'POST', {
        ...query,
        eventId: foreignEvent.id,
      })
    ).body.allowed,
    false,
  );
  await fixture.request(orgPath('/members/staff'), owner, 'DELETE');
  await assert.rejects(
    requirePolicy(fixture.origin, machine, query),
    (error) => error.getStatus() === 403,
  );
  assert.equal((await fixture.request(orgPath('/events'), staff)).status, 404);
});

test('last Owner cannot be removed or demoted, including two concurrent self-demotions', async () => {
  assert.equal(
    (await fixture.request(orgPath('/members/test-owner'), owner, 'DELETE')).body.code,
    'LAST_OWNER',
  );
  const second = await join('second-owner', 'MANAGER');
  assert.equal(
    (await fixture.request(orgPath('/members/second-owner'), owner, 'PATCH', { role: 'OWNER' }))
      .status,
    200,
  );
  const results = await Promise.all([
    fixture.request(orgPath('/members/test-owner'), owner, 'PATCH', { role: 'MANAGER' }),
    fixture.request(orgPath('/members/second-owner'), second, 'PATCH', { role: 'MANAGER' }),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal(
    await fixture.db.membership.count({ where: { organizationId: organization, role: 'OWNER' } }),
    1,
  );
  assert.ok(
    (await fixture.db.auditEntry.count({
      where: { organizationId: organization, action: 'membership.role_changed' },
    })) >= 2,
  );
});
