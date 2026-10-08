import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { ticketsService } from '../helpers/tickets-service.mjs';
import { testIdentity, jsonRequest } from '../helpers/identity.mjs';
import { cleanBroker } from '../helpers/broker.mjs';
test('ticket mail issues use the ticket service audience and bounded pages', async () => {
  const identity = await testIdentity(),
    namespace = `eventflow-test-${randomUUID()}`;
  let fixture;
  try {
    fixture = await ticketsService(namespace, {
      OIDC_ISSUER: identity.issuer,
      MAIL_DELIVERY_DISABLED: 'true',
    });
    const id = randomUUID();
    await fixture.db.deliveryJob.create({ data: { id, state: 'DEAD', attempts: 4 } });
    const viewer = await identity.token('viewer', {
      aud: 'eventflow-tickets',
      realm_access: { roles: ['ops-view'] },
    });
    const result = await jsonRequest(fixture.origin, '/internal/ops/issues?limit=1', viewer);
    assert.equal(result.status, 200);
    assert.equal(result.body.items[0].id, id);
    assert.equal(
      (
        await jsonRequest(
          fixture.origin,
          '/internal/ops/issues',
          await identity.token('buyer', { aud: 'eventflow-tickets' }),
        )
      ).status,
      403,
    );
  } finally {
    await fixture?.close();
    await identity.close();
    await cleanBroker(namespace);
  }
});
