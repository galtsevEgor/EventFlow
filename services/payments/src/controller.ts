import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import { ApiError, parseInput, TokenVerifier } from '@eventflow/service-runtime';
import type { Response } from 'express';
import { z } from 'zod';
import { CreateAttempt } from './attempts/create';
import { ReadPayment } from './attempts/read';
import { ProcessAttempt } from './attempts/process';
import { BookingClient } from './booking-client';
import { FakePaymentProvider } from './providers/fake';
import type { PaymentProvider } from './providers/provider';

@Controller('api/v1/orders')
export class PaymentController {
  constructor(
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
    @Inject(CreateAttempt) private readonly create: CreateAttempt,
    @Inject(ReadPayment) private readonly read: ReadPayment,
    @Inject(ProcessAttempt) private readonly process: ProcessAttempt,
    @Inject(BookingClient) private readonly booking: BookingClient,
    @Inject('PAYMENT_PROVIDER') private readonly provider: PaymentProvider,
  ) {}
  private async buyer(auth: string | undefined) {
    const buyer = await this.verifier.user(auth);
    if (!buyer.emailVerified) throw new ApiError(403, 'EMAIL_UNVERIFIED', 'Подтвердите email.');
    return buyer.subject;
  }
  @Post(':id/payment-attempt')
  @HttpCode(202)
  async start(
    @Headers('authorization') auth: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const buyer = await this.buyer(auth);
    parseInput(z.strictObject({}), body ?? {});
    response.setHeader('cache-control', 'no-store');
    return this.create.run(buyer, parseInput(z.uuid(), id).toLowerCase(), key, auth!);
  }
  @Get(':id/payment-status')
  async status(
    @Headers('authorization') auth: string | undefined,
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const buyer = await this.buyer(auth);
    response.setHeader('cache-control', 'no-store');
    return this.read.run(parseInput(z.uuid(), id).toLowerCase(), buyer);
  }
  @Post(':id/payment-attempt/fake-confirm')
  @HttpCode(202)
  async simulate(
    @Headers('authorization') auth: string | undefined,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    if (!(this.provider instanceof FakePaymentProvider))
      throw new ApiError(404, 'NOT_FOUND', 'Маршрут не найден.');
    const buyer = await this.buyer(auth);
    const orderId = parseInput(z.uuid(), id).toLowerCase();
    const { outcome } = parseInput(
      z.strictObject({ outcome: z.enum(['success', 'decline', 'processing']) }),
      body,
    );
    const attempt = await this.read.owned(orderId, buyer);
    const order = await this.booking.state(orderId);
    if (
      order.state !== 'HELD' ||
      !attempt.providerPaymentId ||
      !['REQUIRES_ACTION', 'PROCESSING'].includes(attempt.state)
    )
      throw new ApiError(409, 'PAYMENT_NOT_PAYABLE', 'Платёж сейчас нельзя выполнить.');
    await this.provider.confirm(attempt.providerPaymentId, outcome);
    await this.process.wake(attempt.id);
    response.setHeader('cache-control', 'no-store');
    return { accepted: true };
  }
}
