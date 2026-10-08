import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { paymentsFixture } from '../helpers/payments.mjs';
import { pendingRefund } from '../helpers/payment-flow.mjs';
import { paymentReplica } from '../helpers/payment-replica.mjs';
import { jsonRequest } from '../helpers/identity.mjs';
import { ProcessRefund } from '../../services/payments/dist/refunds/process.js';

async function human(fixture, subject) {
  return fixture.identity.token(subject, {
    aud: 'eventflow-payments',
    realm_access: { roles: ['ops-view', 'ops-recover'] },
  });
}

test(
  'competing human commands and SIGKILL after refund preserve one provider effect and the original audit',
  { timeout: 120000 },
  async () => {
    const fixture = await paymentsFixture();
    let first, second;
    try {
      const { refund } = await pendingRefund(fixture);
      await fixture.db.refundOperation.update({
        where: { id: refund.id },
        data: { state: 'REQUIRES_REVIEW', reviewCode: 'RETRY_LIMIT' },
      });
      const path = `/internal/ops/issues/refund/${refund.id}`;
      const tokens = await Promise.all(
        ['first-human', 'second-human'].map((subject) => human(fixture, subject)),
      );
      const before = (await jsonRequest(fixture.origin, path, tokens[0])).body;
      const commands = tokens.map((token, index) => ({
        token,
        key: randomUUID(),
        body: {
          reason: `Recovery after transport outage by operator ${index + 1}`,
          version: before.version,
        },
      }));
      const send = (command) =>
        jsonRequest(
          fixture.origin,
          path + '/recover',
          command.token,
          'POST',
          command.body,
          command.key,
        );
      const replies = await Promise.all(commands.map(send));
      assert.deepEqual(replies.map((reply) => reply.status).sort(), [202, 409]);
      const winner = commands[replies.findIndex((reply) => reply.status === 202)];
      const audit = await fixture.db.operatorAction.findUniqueOrThrow({
        where: { key: winner.key },
      });
      assert.equal(await fixture.db.operatorAction.count(), 1);
      assert.equal(audit.actorType, 'HUMAN');
      assert.equal(audit.expectedVersion, before.version);
      assert.equal(await fixture.db.fakeRefund.count(), 0);

      first = await paymentReplica(fixture);
      await first.run('refund', refund.id, true);
      const inFlight = await fixture.db.refundOperation.findUniqueOrThrow({
        where: { id: refund.id },
      });
      assert.ok(inFlight.lease);
      assert.equal(inFlight.recoveryKey, winner.key);
      assert.equal(inFlight.state, 'UNKNOWN');
      await first.close(true);
      assert.equal((await send(winner)).status, 202);
      const current = (await jsonRequest(fixture.origin, path, winner.token)).body;
      const busy = await send({
        ...winner,
        key: randomUUID(),
        body: { ...winner.body, version: current.version },
      });
      assert.equal(busy.status, 409);
      assert.equal(busy.body.code, 'OPERATION_BUSY');
      assert.equal(await fixture.db.operatorAction.count(), 1);

      // Only this fixture's dead worker lease is advanced; production waits for its SQL deadline.
      await fixture.db.refundOperation.update({
        where: { id: refund.id },
        data: { leaseUntil: new Date(0), nextRunAt: new Date(0) },
      });
      second = await paymentReplica(fixture);
      assert.notEqual(first.pid, second.pid);
      assert.equal((await second.run('refund', refund.id)).claimed, true);
      const completed = await fixture.db.refundOperation.findUniqueOrThrow({
        where: { id: refund.id },
      });
      assert.equal(completed.state, 'SUCCEEDED');
      assert.equal(completed.amountMinor, refund.amountMinor);
      assert.equal(completed.providerPaymentId, refund.providerPaymentId);
      assert.equal(completed.recoveryKey, winner.key);
      assert.equal(completed.lease, null);
      assert.equal(await fixture.db.fakeRefund.count({ where: { operationId: refund.id } }), 1);
      assert.equal((await send(winner)).status, 202);
      assert.equal(await fixture.db.operatorAction.count(), 1);
      const events = await fixture.db.outbox.findMany({
        where: { envelope: { path: ['eventType'], equals: 'RefundSucceeded.v1' } },
      });
      assert.equal(events.filter((row) => row.envelope.data.operationId === refund.id).length, 1);
      const detail = (await jsonRequest(fixture.origin, path, winner.token)).body;
      assert.equal(detail.issue.state, 'SUCCEEDED');
      assert.equal(detail.actions[0].actor, audit.actor);
      assert.equal(detail.recoverable, false);
    } finally {
      await first?.close(true);
      await second?.close(true);
      await fixture.close();
    }
  },
);

test(
  'an accepted recovery during provider outage stays unresolved and never grants a financial success',
  { timeout: 120000 },
  async () => {
    const fixture = await paymentsFixture();
    try {
      const { refund, attempt } = await pendingRefund(fixture);
      await fixture.db.refundOperation.update({
        where: { id: refund.id },
        data: { state: 'REQUIRES_REVIEW', reviewCode: 'RETRY_LIMIT' },
      });
      const token = await human(fixture, 'outage-human'),
        path = `/internal/ops/issues/refund/${refund.id}`;
      const before = (await jsonRequest(fixture.origin, path, token)).body;
      const body = { reason: 'Check provider after reported recovery', version: before.version },
        key = randomUUID();
      assert.equal(
        (await jsonRequest(fixture.origin, path + '/recover', token, 'POST', body, key)).status,
        202,
      );
      fixture.provider.inject('refund', { failBefore: true });
      await fixture.app.get(ProcessRefund).run(refund.id);
      const detail = (await jsonRequest(fixture.origin, path, token)).body;
      assert.equal(detail.issue.state, 'UNKNOWN');
      assert.equal(detail.actions.length, 1);
      assert.equal(await fixture.db.fakeRefund.count(), 0);
      assert.notEqual(
        (await fixture.db.paymentAttempt.findUniqueOrThrow({ where: { id: attempt.id } }))
          .bookingState,
        'REFUNDED',
      );
      assert.equal(
        await fixture.db.outbox.count({
          where: { envelope: { path: ['eventType'], equals: 'RefundSucceeded.v1' } },
        }),
        0,
      );
      assert.equal(
        (await jsonRequest(fixture.origin, path + '/recover', token, 'POST', body, key)).status,
        202,
      );
      assert.equal(await fixture.db.operatorAction.count(), 1);
    } finally {
      await fixture.close();
    }
  },
);
