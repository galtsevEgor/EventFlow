import type { Database } from '../database';
import {
  InvalidWebhook,
  ProviderMismatch,
  ProviderUnavailable,
  type PaymentInput,
  type PaymentProvider,
  type ProviderPayment,
  type RefundInput,
  type ProviderRefund,
} from './provider';

type Operation = 'create' | 'retrieve' | 'cancel' | 'refund';
type Fault = { delayMs?: number; loseResponse?: boolean; failBefore?: boolean };

export class FakePaymentProvider implements PaymentProvider {
  readonly name = 'fake';
  // Fault injection is an in-process test seam, never an HTTP endpoint or environment input.
  private faults = new Map<Operation, Fault[]>();
  constructor(private readonly db: Database) {}
  inject(operation: Operation, fault: Fault) {
    this.faults.set(operation, [...(this.faults.get(operation) ?? []), fault]);
  }
  private async execute<T>(operation: Operation, effect: () => Promise<T>) {
    const fault = this.faults.get(operation)?.shift();
    if (fault?.delayMs) await new Promise((done) => setTimeout(done, fault.delayMs));
    if (fault?.failBefore) throw new ProviderUnavailable();
    const result = await effect();
    if (fault?.loseResponse) throw new ProviderUnavailable();
    return result;
  }
  private payment(row: {
    id: string;
    attemptId: string;
    orderId: string;
    amountMinor: number;
    currency: string;
    status: string;
  }): ProviderPayment {
    if (!['requires_action', 'processing', 'succeeded', 'cancelled'].includes(row.status))
      throw new ProviderMismatch();
    return { ...row, status: row.status as ProviderPayment['status'] };
  }
  create(input: PaymentInput) {
    return this.execute('create', async () => {
      await this.db
        .$executeRaw`INSERT INTO "FakePayment" (id, "attemptId", "orderId", "amountMinor", currency, status)
        VALUES (${`fake_pi_${input.attemptId}`}, ${input.attemptId}::uuid, ${input.orderId}::uuid, ${input.amountMinor}, ${input.currency}, 'requires_action')
        ON CONFLICT DO NOTHING`;
      const row = await this.db.fakePayment.findUniqueOrThrow({
        where: { attemptId: input.attemptId },
      });
      if (
        row.orderId !== input.orderId ||
        row.amountMinor !== input.amountMinor ||
        row.currency !== input.currency
      )
        throw new ProviderMismatch();
      return this.payment(row);
    });
  }
  retrieve(id: string) {
    return this.execute('retrieve', async () => {
      const row = await this.db.fakePayment.findUnique({ where: { id } });
      if (!row) throw new ProviderMismatch();
      return this.payment(row);
    });
  }
  cancel(id: string) {
    return this.execute('cancel', async () => {
      await this.db.fakePayment.updateMany({
        where: { id, status: 'requires_action' },
        data: { status: 'cancelled' },
      });
      return this.retrieve(id);
    });
  }
  async confirm(id: string, outcome: 'success' | 'decline' | 'processing') {
    await this.db.fakePayment.updateMany({
      where: { id, status: { in: ['requires_action', 'processing'] } },
      data: {
        status: { success: 'succeeded', decline: 'requires_action', processing: 'processing' }[
          outcome
        ],
      },
    });
    return this.retrieve(id);
  }
  refund(input: RefundInput) {
    return this.execute('refund', async () => {
      const payment = await this.retrieve(input.paymentId);
      if (payment.status !== 'succeeded' || payment.amountMinor !== input.amountMinor)
        throw new ProviderMismatch();
      await this.db
        .$executeRaw`INSERT INTO "FakeRefund" (id, "operationId", "paymentId", "amountMinor", status)
        VALUES (${`fake_re_${input.operationId}`}, ${input.operationId}::uuid, ${input.paymentId}, ${input.amountMinor}, 'succeeded')
        ON CONFLICT DO NOTHING`;
      const row = await this.db.fakeRefund.findUnique({ where: { paymentId: input.paymentId } });
      if (!row || row.operationId !== input.operationId || row.amountMinor !== input.amountMinor)
        throw new ProviderMismatch();
      return { ...row, status: row.status as ProviderRefund['status'] };
    });
  }
  async findRefund(input: RefundInput): Promise<ProviderRefund | null> {
    const row = await this.db.fakeRefund.findUnique({ where: { operationId: input.operationId } });
    return row ? { ...row, status: row.status as ProviderRefund['status'] } : null;
  }
  verifyWebhook(): never {
    throw new InvalidWebhook();
  }
}
