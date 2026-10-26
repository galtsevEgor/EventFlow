import { Body, Controller, Headers, HttpCode, Inject, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { ApiError, parseInput, TokenVerifier } from '@eventflow/service-runtime';
import { Reserve } from './reserve';
import { Database } from '../database';
import { OrderLifecycle } from './lifecycle';
import { PaymentAuthorization } from '../payments/authorization';
const context = z.strictObject({ entryId: z.uuid(), buyerSubject: z.string().min(1).max(255) });
const reservation = context.extend({
  requestId: z.uuid(),
  saleId: z.uuid(),
  categoryId: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/),
  email: z.email(),
});
@Controller('internal/waitlist')
export class WaitlistReservationsController {
  constructor(
    @Inject(TokenVerifier) private readonly tokens: TokenVerifier,
    @Inject(Reserve) private readonly reserve: Reserve,
    @Inject(Database) private readonly db: Database,
    @Inject(OrderLifecycle) private readonly lifecycle: OrderLifecycle,
    @Inject(PaymentAuthorization) private readonly orders: PaymentAuthorization,
  ) {}
  private authorize(auth: string | undefined) {
    return this.tokens.service(auth, 'eventflow-waitlist', 'booking-waitlist');
  }
  @Post('reservations')
  async create(
    @Headers('authorization') auth: string | undefined,
    @Body() input: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.authorize(auth);
    const d = parseInput(reservation, input);
    const result = await this.reserve.category(
      d.buyerSubject,
      d.requestId,
      d.saleId,
      d.categoryId,
      d.entryId,
      d.email,
    );
    response.status(result.status);
    return result.body;
  }
  private async owned(input: unknown) {
    const d = parseInput(context, input);
    const order = await this.db.order.findFirst({
      where: { waitlistEntryId: d.entryId, buyerSubject: d.buyerSubject },
    });
    if (!order) throw new ApiError(404, 'NOT_FOUND', 'Предложение не найдено.');
    return order;
  }
  @Post('status')
  @HttpCode(200)
  async status(@Headers('authorization') auth: string | undefined, @Body() input: unknown) {
    await this.authorize(auth);
    const order = await this.owned(input);
    return this.orders.read(order.id, order.buyerSubject, true);
  }
  @Post('cancel')
  @HttpCode(200)
  async cancel(@Headers('authorization') auth: string | undefined, @Body() input: unknown) {
    await this.authorize(auth);
    const order = await this.owned(input);
    // Confirmation wins a concurrent cancellation. Never touch an unrelated buyer order.
    try {
      await this.lifecycle.cancel(order.buyerSubject, order.id);
    } catch (error) {
      if (
        !(error instanceof ApiError) ||
        (error.getResponse() as { code?: string }).code !== 'ORDER_CONFIRMED'
      )
        throw error;
    }
    return this.orders.read(order.id, order.buyerSubject, true);
  }
}
