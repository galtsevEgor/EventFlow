import { Controller, Get, Headers, Inject, Param } from '@nestjs/common';
import { ApiError, parseInput, SecretBox, TokenVerifier } from '@eventflow/service-runtime';
import { z } from 'zod';
import { Database } from '../database';

@Controller('internal/orders')
export class DeliveryContextController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
    @Inject(SecretBox) private readonly contact: SecretBox,
  ) {}

  @Get(':id/delivery-context')
  async get(@Headers('authorization') auth: string | undefined, @Param('id') input: string) {
    await this.verifier.service(auth, 'eventflow-ticket-delivery', 'booking-ticket-delivery');
    const id = parseInput(z.uuid(), input).toLowerCase();
    const order = await this.db.order.findFirst({
      where: {
        id,
        state: 'CONFIRMED',
        OR: [{ refund: null }, { refund: { is: { state: 'REJECTED' } } }],
      },
      select: { contactEmail: true },
    });
    if (!order) throw new ApiError(404, 'NOT_FOUND', 'Заказ не найден.');
    return { email: order.contactEmail ? this.contact.open(order.contactEmail, id) : null };
  }

  @Get(':id/refund-delivery-context')
  async refunded(@Headers('authorization') auth: string | undefined, @Param('id') input: string) {
    await this.verifier.service(auth, 'eventflow-ticket-delivery', 'booking-ticket-delivery');
    const id = parseInput(z.uuid(), input).toLowerCase();
    const order = await this.db.order.findFirst({
      where: { id, state: 'REFUNDED', refund: { is: { state: 'SUCCEEDED' } } },
      select: { contactEmail: true },
    });
    if (!order) throw new ApiError(404, 'NOT_FOUND', 'Заказ не найден.');
    return { email: order.contactEmail ? this.contact.open(order.contactEmail, id) : null };
  }
}
