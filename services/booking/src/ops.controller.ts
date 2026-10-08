import { Controller, Get, Headers, Inject, Param } from '@nestjs/common';
import { ApiError, parseInput, TokenVerifier } from '@eventflow/service-runtime';
import { z } from 'zod';
import { Database } from './database';

@Controller('internal/ops')
export class BookingOps {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
  ) {}
  @Get('orders/:id')
  async order(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') rawId: string,
  ) {
    await this.verifier.operator(authorization);
    const id = parseInput(z.uuid(), rawId);
    const row = await this.db.order.findUnique({
      where: { id },
      select: { id: true, saleId: true, state: true, totalMinor: true, currency: true },
    });
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Заказ не найден.');
    return { ...row, seatCount: await this.db.orderItem.count({ where: { orderId: id } }) };
  }
}
