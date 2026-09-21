import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test, mock } from 'node:test';
import { paymentsFixture } from '../helpers/payments.mjs';
import { ticketsService } from '../helpers/tickets-service.mjs';
import { confirmedOrder } from '../helpers/confirmed-refund.mjs';
import { eventually } from '../helpers/eventually.mjs';
import { jsonRequest } from '../helpers/identity.mjs';
import { RefundAccess } from '../../services/booking/dist/refunds/access.js';
import { RefundWorkflow } from '../../services/booking/dist/refunds/workflow.js';
import { ProcessRefund } from '../../services/payments/dist/refunds/process.js';
import { FakePaymentProvider } from '../../services/payments/dist/providers/fake.js';
import { CheckInTicket } from '../../services/tickets/dist/check-in.js';
import { QrCredentials } from '../../services/tickets/dist/qr-credentials.js';
import { message } from '../../packages/event-contracts/dist/index.js';
import {
  ClientCredentials,
  MailQueue,
  MailWorker,
} from '../../packages/service-runtime/dist/index.js';
import { DeliverTickets } from '../../services/tickets/dist/deliver.js';
import { receivedMail, findMail, smtpProxy } from '../helpers/mailpit.mjs';

let fixture, tickets, refunds;
before(async () => {
  fixture = await paymentsFixture();
  mock.method(fixture.booking.app.get(RefundAccess), 'check', async () => {});
  tickets = await ticketsService(fixture.namespace, {
    OIDC_ISSUER: fixture.identity.issuer,
    MAIL_DELIVERY_DISABLED: 'true',
  });
  refunds = fixture.app.get(ProcessRefund);
});
after(async () => {
  await tickets?.close();
  await fixture?.close();
});
const waitRefund = (orderId) =>
  eventually(() => fixture.db.refundOperation.findFirst({ where: { orderId } }), Boolean);
async function issued(flow) {
  return eventually(
    () => tickets.db.ticket.findMany({ where: { orderId: flow.order.id } }),
    (rows) => rows.length === 2,
  );
}
const scan = async (flow, ticket) =>
  new CheckInTicket(tickets.db).run(
    'staff',
    {
      requestId: randomUUID(),
      organizationId: flow.sale.organizationId,
      eventId: flow.sale.id,
      credential: new QrCredentials(process.env.TICKET_QR_KEYS).reveal(ticket),
    },
    {
      admissionStartsAt: flow.sale.admissionStartsAt.toISOString(),
      admissionEndsAt: flow.sale.admissionEndsAt.toISOString(),
    },
  );

test('confirmed refund fences all tickets before provider execution, frees seats once and rejects old QR', async () => {
  const flow = await confirmedOrder(fixture),
    rows = await issued(flow);
  assert.equal((await flow.request()).status, 202);
  const operation = await waitRefund(flow.order.id);
  assert.equal(
    (await tickets.db.refundGate.findUnique({ where: { orderId: flow.order.id } })).state,
    'LOCKED',
  );
  assert.equal((await scan(flow, rows[0])).result, 'REFUND_PENDING');
  assert.equal(
    (
      await jsonRequest(
        tickets.origin,
        `/api/v1/orders/${flow.order.id}/tickets/${rows[0].id}/code`,
        flow.buyer,
      )
    ).status,
    409,
  );
  await Promise.all(Array.from({ length: 8 }, () => refunds.run(operation.id)));
  await eventually(
    () => fixture.booking.db.order.findUnique({ where: { id: flow.order.id } }),
    (row) => row.state === 'REFUNDED',
  );
  await eventually(
    () => tickets.db.refundGate.findUnique({ where: { orderId: flow.order.id } }),
    (row) => row?.state === 'REVOKED',
  );
  assert.equal((await scan(flow, rows[0])).result, 'REFUNDED');
  assert.equal(await fixture.db.fakeRefund.count({ where: { operationId: operation.id } }), 1);
  assert.equal(
    await fixture.booking.db.seatInventory.count({
      where: { saleId: flow.sale.id, state: 'AVAILABLE' },
    }),
    8,
  );
  const newer = await jsonRequest(
    fixture.booking.origin,
    '/api/v1/orders',
    flow.buyer,
    'POST',
    { saleId: flow.sale.id, seatIds: ['r1-s1'] },
    randomUUID(),
  );
  assert.equal(newer.status, 201);
  const outcome = (await fixture.db.outbox.findMany()).find(
    (row) =>
      row.envelope.eventType === 'ConfirmedOrderRefundSucceeded.v1' &&
      row.envelope.data.operationId === operation.id,
  ).envelope;
  const workflow = new RefundWorkflow(fixture.booking.db);
  await workflow.handle({ ...outcome, eventId: randomUUID() });
  await workflow.handle(
    message('payments', 'ConfirmedOrderRefundReviewRequired.v1', flow.order.id, 1, {
      ...outcome.data,
      state: 'REQUIRES_REVIEW',
      code: 'STALE_FAILURE',
    }),
  );
  assert.equal(
    (await fixture.booking.db.orderRefund.findUnique({ where: { id: operation.id } })).state,
    'SUCCEEDED',
  );
  assert.equal(
    (
      await fixture.booking.db.seatInventory.findUnique({
        where: { saleId_seatId: { saleId: flow.sale.id, seatId: 'r1-s1' } },
      })
    ).currentOrderId,
    newer.body.id,
  );
});

test('used ticket rejects the complete refund before any provider command', async () => {
  const flow = await confirmedOrder(fixture),
    rows = await issued(flow);
  assert.equal((await scan(flow, rows[0])).result, 'ADMITTED');
  await flow.request();
  const refund = await eventually(
    () => fixture.booking.db.orderRefund.findUnique({ where: { orderId: flow.order.id } }),
    (row) => row?.state === 'REJECTED',
  );
  assert.equal(refund.code, 'TICKETS_USED');
  assert.equal(await fixture.db.refundOperation.count({ where: { orderId: flow.order.id } }), 0);
  assert.equal((await scan(flow, rows[1])).result, 'ADMITTED');
});

test('lost provider reply keeps admission fenced and restart discovers the original refund', async () => {
  const flow = await confirmedOrder(fixture),
    rows = await issued(flow);
  await flow.request();
  const operation = await waitRefund(flow.order.id);
  fixture.provider.inject('refund', { loseResponse: true });
  await refunds.run(operation.id);
  assert.equal(
    (await fixture.db.refundOperation.findUnique({ where: { id: operation.id } })).state,
    'UNKNOWN',
  );
  assert.equal((await scan(flow, rows[0])).result, 'REFUND_PENDING');
  await fixture.db.refundOperation.update({
    where: { id: operation.id },
    data: { nextRunAt: new Date(0) },
  });
  await new ProcessRefund(fixture.db, new FakePaymentProvider(fixture.db)).run(operation.id);
  await eventually(
    () => fixture.booking.db.order.findUnique({ where: { id: flow.order.id } }),
    (row) => row.state === 'REFUNDED',
  );
  assert.equal(await fixture.db.fakeRefund.count({ where: { operationId: operation.id } }), 1);
});

test('refund notification survives SMTP failure with one durable job and private delivery context', async () => {
  const flow = await confirmedOrder(fixture);
  await issued(flow);
  const requested = await flow.request();
  const operation = await waitRefund(flow.order.id);
  const credentials = new ClientCredentials(
    fixture.identity.issuer,
    'eventflow-ticket-delivery',
    fixture.identity.serviceSecret,
  );
  const service = await credentials.token();
  const context = `/internal/orders/${flow.order.id}/refund-delivery-context`;
  assert.equal((await jsonRequest(fixture.booking.origin, context, service)).status, 404);
  await refunds.run(operation.id);
  await eventually(
    () => tickets.db.deliveryJob.findUnique({ where: { id: operation.id } }),
    Boolean,
  );
  assert.equal((await jsonRequest(fixture.booking.origin, context, flow.buyer)).status, 403);
  assert.deepEqual((await jsonRequest(fixture.booking.origin, context, service)).body, {
    email: 'buyer@eventflow.test',
  });
  assert.equal(
    (
      await jsonRequest(
        fixture.booking.origin,
        `/internal/orders/${flow.order.id}/delivery-context`,
        service,
      )
    ).status,
    404,
  );
  const smtp = await smtpProxy();
  const queue = new MailQueue((sql, ...values) => tickets.db.$queryRawUnsafe(sql, ...values));
  const delivery = new DeliverTickets({
    ...process.env,
    OIDC_ISSUER: fixture.identity.issuer,
    TICKET_DELIVERY_CLIENT_SECRET: fixture.identity.serviceSecret,
    BOOKING_URL: fixture.booking.origin,
    PUBLIC_ORIGIN: 'http://127.0.0.1:3000/',
    MAILPIT_SMTP_PORT: smtp.port,
  });
  const worker = new MailWorker(queue, async (id) => {
    const gate = await tickets.db.refundGate.findUnique({ where: { operationId: id } });
    return gate?.state === 'REVOKED' ? delivery.refund(id, gate.orderId) : 'SKIPPED';
  });
  try {
    worker.onModuleInit();
    await eventually(
      () => tickets.db.deliveryJob.findUnique({ where: { id: operation.id } }),
      (row) => row?.attempts > 0 && row.lease === null,
    );
    assert.equal((await findMail(`tickets-${operation.id}@eventflow.test`)).length, 0);
    smtp.restore();
    await tickets.db.deliveryJob.update({
      where: { id: operation.id },
      data: { nextRunAt: new Date(0) },
    });
    await eventually(
      () => tickets.db.deliveryJob.findUnique({ where: { id: operation.id } }),
      (row) => row?.state === 'SENT',
    );
    const mail = await receivedMail(`tickets-${operation.id}@eventflow.test`);
    assert.equal(mail.Subject, 'Возврат оплаты EventFlow выполнен');
    assert.ok(mail.Text.includes(`/orders/${flow.order.id}`));
    assert.equal(mail.Text.includes(requested.body.reason), false);
    assert.equal(await tickets.db.deliveryJob.count({ where: { id: operation.id } }), 1);
  } finally {
    await worker.onModuleDestroy();
    await smtp.close();
  }
});
