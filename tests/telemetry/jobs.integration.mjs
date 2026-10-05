import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { currentTraceparent } from '../../packages/telemetry/dist/index.js';
import { MailQueue, MailWorker, Mailpit } from '../../packages/service-runtime/dist/index.js';
import { ProcessAttempt } from '../../services/payments/dist/attempts/process.js';
import { BookingClient } from '../../services/payments/dist/booking-client.js';
import { paymentsFixture } from '../helpers/payments.mjs';
import { ticketsService } from '../helpers/tickets-service.mjs';
import { seedSale } from '../helpers/sale.mjs';
import { jsonRequest } from '../helpers/identity.mjs';
import { eventually } from '../helpers/eventually.mjs';
import { findMail } from '../helpers/mailpit.mjs';
import { readTrace, traceSpans, traceHex } from '../helpers/traces.mjs';

test(
  'payment and mail retries restore durable context across new processors without exposing provider failures or email',
  { timeout: 120000 },
  async () => {
    const keys = [
      'EVENTFLOW_TELEMETRY_ENABLED',
      'EVENTFLOW_TRACE_SAMPLE_RATIO',
      'EVENTFLOW_ENVIRONMENT',
    ];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.EVENTFLOW_TELEMETRY_ENABLED = 'true';
    process.env.EVENTFLOW_ENVIRONMENT = 'test';
    process.env.EVENTFLOW_TRACE_SAMPLE_RATIO = '1';
    let fixture, tickets, mailWorker;
    const mailContexts = [];
    try {
      fixture = await paymentsFixture();
      const restored = new ProcessAttempt(
        fixture.db,
        fixture.app.get(BookingClient),
        fixture.provider,
      );
      restored.onModuleInit();
      tickets = await ticketsService(fixture.namespace, { MAIL_DELIVERY_DISABLED: 'true' });
      const buyer = await fixture.identity.token('buyer', {
        aud: ['eventflow-booking', 'eventflow-payments'],
      });
      const sale = await seedSale(fixture.booking.db);
      const reserved = await jsonRequest(
        fixture.booking.origin,
        '/api/v1/orders',
        buyer,
        'POST',
        { saleId: sale.id, seatIds: ['r1-s1'] },
        randomUUID(),
      );
      assert.equal(reserved.status, 201);
      const orderId = reserved.body.id,
        traceId = randomBytes(16).toString('hex');
      const response = await fetch(fixture.origin + `/api/v1/orders/${orderId}/payment-attempt`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${buyer}`,
          'idempotency-key': randomUUID(),
          'content-type': 'application/json',
          traceparent: `00-${traceId}-${randomBytes(8).toString('hex')}-01`,
        },
        body: '{}',
      });
      assert.equal(response.status, 202);
      const { attemptId } = await response.json();
      const stored = await fixture.db.paymentAttempt.findUniqueOrThrow({
        where: { id: attemptId },
      });
      assert.equal(stored.traceparent.split('-')[1], traceId);
      fixture.provider.inject('create', { failBefore: true });
      assert.equal(await restored.run(attemptId), true);
      assert.equal(
        (await fixture.db.paymentAttempt.findUniqueOrThrow({ where: { id: attemptId } })).state,
        'NEEDS_RECONCILIATION',
      );
      await restored.wake(attemptId);
      assert.equal(await restored.run(attemptId), true);
      const payable = await fixture.db.paymentAttempt.findUniqueOrThrow({
        where: { id: attemptId },
      });
      await fixture.provider.confirm(payable.providerPaymentId, 'success');
      await restored.wake(attemptId);
      assert.equal(await restored.run(attemptId), true);
      await eventually(
        () => fixture.booking.db.order.findUnique({ where: { id: orderId } }),
        (row) => row.state === 'CONFIRMED',
      );
      const job = await eventually(
        () => tickets.db.deliveryJob.findUnique({ where: { id: orderId } }),
        Boolean,
      );
      assert.ok(job.traceparent);
      const initial = await readTrace(traceId, (body) =>
        traceSpans(body).some((span) => span.name === 'payment.provider.create'),
      );
      assert.ok(
        traceSpans(initial).some(
          (span) =>
            span.name === 'payment.provider.create' &&
            span.service === 'payments' &&
            (span.status?.code === 'STATUS_CODE_ERROR' || span.status?.code === 2),
        ),
      );
      const succeeded = (await fixture.db.outbox.findMany()).find(
        (row) => row.envelope.eventType === 'PaymentSucceeded.v1',
      );
      const settledId = succeeded.envelope.traceparent.split('-')[1];
      assert.notEqual(settledId, traceId);
      const settled = await readTrace(settledId, (body) =>
        traceSpans(body).some((span) => span.service === 'tickets'),
      );
      assert.ok(
        traceSpans(settled).some((span) =>
          (span.links ?? []).some((link) => traceHex(link.traceId) === traceId),
        ),
      );

      const queue = new MailQueue((sql, ...values) => tickets.db.$queryRawUnsafe(sql, ...values));
      mailWorker = new MailWorker(queue, async () => {
        mailContexts.push(currentTraceparent());
        throw new Error('private-smtp-failure');
      });
      mailWorker.onModuleInit();
      await eventually(
        () => tickets.db.deliveryJob.findUnique({ where: { id: orderId } }),
        (row) => row.attempts === 1 && row.lease === null,
      );
      await mailWorker.onModuleDestroy();
      const smtp = new Mailpit(Number(process.env.MAILPIT_SMTP_PORT), 'tickets');
      mailWorker = new MailWorker(queue, async (id) => {
        mailContexts.push(currentTraceparent());
        return smtp.send(
          id,
          'private-email@eventflow.test',
          'Telemetry fixture',
          'Synthetic delivery test',
        );
      });
      mailWorker.onModuleInit();
      await eventually(
        () => tickets.db.deliveryJob.findUnique({ where: { id: orderId } }),
        (row) => row.state === 'SENT',
        20000,
      );
      assert.equal(mailContexts.length, 2);
      assert.notEqual(mailContexts[1].split('-')[1], mailContexts[0].split('-')[1]);
      const delivery = await readTrace(mailContexts[1].split('-')[1], (body) =>
        traceSpans(body).some((span) => span.name === 'mail.smtp'),
      );
      assert.ok(
        traceSpans(delivery).some((span) =>
          (span.links ?? []).some(
            (link) => traceHex(link.traceId) === job.traceparent.split('-')[1],
          ),
        ),
      );
      assert.ok(!JSON.stringify([initial, settled, delivery]).includes('private'));
      assert.equal((await findMail(`tickets-${orderId}@eventflow.test`)).length, 1);
      assert.equal(await tickets.db.ticket.count({ where: { orderId } }), 1);
      assert.equal(await fixture.db.fakePayment.count({ where: { attemptId } }), 1);
    } finally {
      await mailWorker?.onModuleDestroy();
      await tickets?.close();
      await fixture?.close();
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  },
);
