import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from '@nestjs/common';
import { ApiError, parseInput, TokenVerifier } from '@eventflow/service-runtime';
import type { Response } from 'express';
import { z } from 'zod';
import { PaymentAuthorization } from './authorization';

@Controller()
export class BookingPaymentsController {
  constructor(
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
    @Inject(PaymentAuthorization) private readonly payments: PaymentAuthorization,
  ) {}
  @Get('internal/buyer/orders/:id/payment-state')
  async payable(
    @Headers('authorization') auth: string | undefined,
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const buyer = await this.verifier.user(auth);
    if (!buyer.emailVerified) throw new ApiError(403, 'EMAIL_UNVERIFIED', 'Подтвердите email.');
    response.setHeader('cache-control', 'no-store');
    return this.payments.read(parseInput(z.uuid(), id), buyer.subject);
  }
  @Get('internal/orders/:id/payment-state')
  async state(
    @Headers('authorization') auth: string | undefined,
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.verifier.service(auth, 'eventflow-payments', 'booking-payments');
    response.setHeader('cache-control', 'no-store');
    return this.payments.read(parseInput(z.uuid(), id));
  }
  @Post('internal/orders/:id/payment-authorization')
  async authorize(
    @Headers('authorization') auth: string | undefined,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.verifier.service(auth, 'eventflow-payments', 'booking-payments');
    const value = parseInput(
      z.strictObject({
        attemptId: z.uuid(),
        buyerSubject: z.string().min(1).max(255),
        provider: z.enum(['fake', 'stripe']),
      }),
      body,
    );
    response.setHeader('cache-control', 'no-store');
    return this.payments.authorize(
      parseInput(z.uuid(), id),
      value.attemptId.toLowerCase(),
      value.buyerSubject,
      value.provider,
    );
  }
}
