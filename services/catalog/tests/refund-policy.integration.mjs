import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { catalogFixture } from './fixture.mjs';

test('refund policy admits current owners and managers while excluding assigned staff and foreign scopes', async () => {
  const fixture = await catalogFixture();
  try {
    const org = await fixture.db.organization.create({
      data: { name: 'Refund policy', createdBy: 'owner' },
    });
    const event = await fixture.db.eventDraft.create({
      data: { organizationId: org.id, title: 'Refund event' },
    });
    for (const [userSubject, role] of [
      ['owner', 'OWNER'],
      ['manager', 'MANAGER'],
      ['staff', 'STAFF'],
    ])
      await fixture.db.membership.create({
        data: { organizationId: org.id, userSubject, role, email: `${userSubject}@eventflow.test` },
      });
    await fixture.db.staffAssignment.create({
      data: { organizationId: org.id, userSubject: 'staff', eventId: event.id },
    });
    const token = await fixture.token({
      sub: 'policy',
      azp: 'eventflow-policy',
      realm_access: { roles: ['policy-check'] },
    });
    const scope = { organizationId: org.id, eventId: event.id, action: 'orders:refund' };
    const check = (actorSubject, extra = {}) =>
      fixture.request('/internal/policy/check', token, 'POST', {
        ...scope,
        actorSubject,
        ...extra,
      });
    assert.equal((await check('owner')).body.allowed, true);
    assert.equal((await check('manager')).body.allowed, true);
    assert.equal((await check('staff')).body.allowed, false);
    assert.equal((await check('outsider')).body.allowed, false);
    assert.equal((await check('owner', { eventId: randomUUID() })).body.allowed, false);
    await fixture.db.membership.update({
      where: { organizationId_userSubject: { organizationId: org.id, userSubject: 'manager' } },
      data: { role: 'STAFF' },
    });
    assert.equal((await check('manager')).body.allowed, false);
  } finally {
    await fixture.close();
  }
});
