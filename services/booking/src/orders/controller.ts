import { Controller, Get, Post, Param, Query, Body, Headers, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApiError, parseInput, TokenVerifier } from '@eventflow/service-runtime';
import { z } from 'zod';
import { Reserve } from './reserve';
import { OrderReader } from './reader';
import { OrderLifecycle } from './lifecycle';

@Controller('api/v1/orders')
export class OrderController {
  constructor(
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
    @Inject(Reserve) private readonly reserve: Reserve,
    @Inject(OrderReader) private readonly reader: OrderReader,
    @Inject(OrderLifecycle) private readonly lifecycle: OrderLifecycle,
  ) {}
  private async buyer(authorization: string | undefined) {
    const user = await this.verifier.user(authorization);
    if (!user.emailVerified) throw new ApiError(403, 'EMAIL_UNVERIFIED', 'Подтвердите email.');
    return user.subject;
  }
  @Post()
  async create(
    @Headers('authorization') auth: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
    @Res() response: Response,
  ) {
    const result = await this.reserve.run(await this.buyer(auth), key, body);
    if (result.status !== 201)
      throw new ApiError(result.status, String(result.body.code), String(result.body.message));
    response.setHeader('cache-control', 'no-store');
    response.status(result.status).json(result.body);
  }
  @Get()
  async list(
    @Headers('authorization') auth: string | undefined,
    @Query() query: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const buyer = await this.buyer(auth);
    const values = parseInput(
      z.strictObject({
        page: z.coerce.number().int().min(1).max(10000).default(1),
        saleId: z.uuid().optional(),
      }),
      query,
    );
    response.setHeader('cache-control', 'no-store');
    return this.reader.list(buyer, values.page, values.saleId);
  }
  @Get(':id')
  async read(
    @Headers('authorization') auth: string | undefined,
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    const buyer = await this.buyer(auth);
    response.setHeader('cache-control', 'no-store');
    return this.reader.read(buyer, parseInput(z.uuid(), id));
  }
  @Post(':id/cancel')
  async cancel(
    @Headers('authorization') auth: string | undefined,
    @Param('id') id: string,
    @Res() response: Response,
  ) {
    const result = await this.lifecycle.cancel(await this.buyer(auth), parseInput(z.uuid(), id));
    response.setHeader('cache-control', 'no-store');
    response.status(200).json(result);
  }
}
