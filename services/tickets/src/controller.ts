import { Controller, Get, Headers, Inject, Param, Res } from '@nestjs/common';
import { ApiError, parseInput, TokenVerifier } from '@eventflow/service-runtime';
import type { Response } from 'express';
import { toBuffer } from 'qrcode';
import { z } from 'zod';
import { Database } from './database';
import { QrCredentials } from './qr-credentials';

const missingTicket = () => new ApiError(404, 'NOT_FOUND', 'Билет не найден.');

@Controller('api/v1/orders/:id/tickets')
export class TicketController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
    @Inject(QrCredentials) private readonly credentials: QrCredentials,
  ) {}

  @Get()
  async list(@Headers('authorization') authorization: string | undefined, @Param('id') id: string) {
    const where = await this.ownedOrder(authorization, id);
    const tickets = await this.db.ticket.findMany({
      where,
      select: { id: true, row: true, number: true, categoryName: true },
      orderBy: [{ row: 'asc' }, { number: 'asc' }],
    });
    if (!tickets.length) throw missingTicket();
    await this.assertActive(where.orderId);
    return { tickets };
  }

  @Get(':ticketId/qr')
  async qr(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Param('ticketId') ticketId: string,
    @Res() response: Response,
  ) {
    const ticket = await this.ownedTicket(authorization, id, ticketId);
    const png = await toBuffer(this.credentials.reveal(ticket), { scale: 8 });
    response.set('content-type', 'image/png');
    response.set('cross-origin-resource-policy', 'same-origin');
    response.end(png);
  }

  @Get(':ticketId/code')
  async code(
    @Headers('authorization') authorization: string | undefined,
    @Param('id') id: string,
    @Param('ticketId') ticketId: string,
  ) {
    return { code: this.credentials.reveal(await this.ownedTicket(authorization, id, ticketId)) };
  }

  private async ownedTicket(authorization: string | undefined, id: string, ticketId: string) {
    const where = await this.ownedOrder(authorization, id);
    const ticket = await this.db.ticket.findFirst({
      where: { ...where, id: parseInput(z.uuid(), ticketId) },
      select: { id: true, qrEncrypted: true, qrKeyId: true },
    });
    if (!ticket) throw missingTicket();
    await this.assertActive(where.orderId);
    return ticket;
  }

  private async assertActive(orderId: string) {
    const gate = await this.db.refundGate.findUnique({ where: { orderId } });
    if (gate?.state === 'LOCKED')
      throw new ApiError(409, 'REFUND_PENDING', 'Билеты заблокированы на время возврата.');
    if (gate?.state === 'REVOKED')
      throw new ApiError(410, 'REFUNDED', 'Билеты аннулированы после возврата.');
  }

  private async ownedOrder(authorization: string | undefined, id: string) {
    const user = await this.verifier.user(authorization);
    if (!user.emailVerified) throw new ApiError(403, 'EMAIL_UNVERIFIED', 'Подтвердите email.');
    return { orderId: parseInput(z.uuid(), id), buyerSubject: user.subject };
  }
}
