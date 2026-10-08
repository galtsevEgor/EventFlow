import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { catalogFixture } from './fixture.mjs';
test('catalog operator mail listing is role protected, paginated and contains no invitation credentials', async () => {
  const fixture = await catalogFixture({ MAIL_DELIVERY_DISABLED: 'true' });
  try {
    const viewer = await fixture.token({ realm_access: { roles: ['ops-view'] } });
    for (let i = 0; i < 3; i++)
      await fixture.db.deliveryJob.create({
        data: {
          id: randomUUID(),
          state: 'DEAD',
          attempts: 4,
          nextRunAt: new Date(Date.now() - 1000),
        },
      });
    assert.equal(
      (await fixture.request('/internal/ops/issues', await fixture.token())).status,
      403,
    );
    const first = await fixture.request('/internal/ops/issues?limit=2', viewer);
    assert.equal(first.status, 200);
    assert.equal(first.body.items.length, 2);
    assert.ok(first.body.nextCursor);
    const second = await fixture.request(
      '/internal/ops/issues?limit=2&cursor=' + first.body.nextCursor,
      viewer,
    );
    assert.equal(second.body.items.length, 1);
    assert.equal(second.body.nextCursor, null);
    assert.ok(
      [...first.body.items, ...second.body.items].every(
        (row) => row.kind === 'mail' && row.orderId === null,
      ),
    );
    const id = first.body.items[0].id;
    await fixture.db.deliveryRetry.create({
      data: { requestId: randomUUID(), jobId: id, actorSubject: 'mail-service' },
    });
    const detail = await fixture.request(`/internal/ops/issues/mail/${id}`, viewer);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.recoverable, false);
    assert.equal(detail.body.actions.length, 1);
    await fixture.db.deliveryJob.update({ where: { id }, data: { state: 'SENT' } });
    const completed = await fixture.request(`/internal/ops/issues/mail/${id}`, viewer);
    assert.equal(completed.body.issue.state, 'SENT');
    assert.equal(completed.body.actions.length, 1);
    const retryId = randomUUID();
    await fixture.db.deliveryJob.create({ data: { id: retryId, state: 'DEAD', attempts: 4 } });
    const operator = await fixture.token({ realm_access: { roles: ['ops-view', 'ops-recover'] } }),
      snapshot = (await fixture.request(`/internal/ops/issues/mail/${retryId}`, operator)).body;
    const key = randomUUID(),
      retried = await fixture.request(
        `/internal/ops/issues/mail/${retryId}/recover`,
        operator,
        'POST',
        { reason: 'Invitation transport restored', version: snapshot.version },
        { 'idempotency-key': key },
      );
    assert.equal(retried.status, 202);
    assert.equal(
      (await fixture.db.deliveryRetry.findUnique({ where: { requestId: key } })).actorType,
      'HUMAN',
    );
  } finally {
    await fixture.close();
  }
});
