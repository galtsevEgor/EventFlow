import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiError, parseInput, TokenVerifier } from '@eventflow/service-runtime';
import { z } from 'zod';
import { OrganizerRefunds } from './organizer';

@Controller('api/v1/organizations/:organizationId/events/:eventId/orders')
export class OrganizerOrdersController {
  constructor(
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
    @Inject(OrganizerRefunds) private readonly refunds: OrganizerRefunds,
  ) {}

  private async actor(authorization: string | undefined) {
    const actor = await this.verifier.user(authorization);
    if (!actor.emailVerified) throw new ApiError(403, 'EMAIL_UNVERIFIED', 'Подтвердите email.');
    return actor.subject;
  }
  @Get() async list(
    @Headers('authorization') auth: string | undefined,
    @Param('organizationId') org: string,
    @Param('eventId') event: string,
    @Query() input: unknown,
  ) {
    const actor = await this.actor(auth);
    const { page } = parseInput(
      z.strictObject({ page: z.coerce.number().int().min(1).max(10000).default(1) }),
      input,
    );
    return this.refunds.list(
      actor,
      parseInput(z.uuid(), org).toLowerCase(),
      parseInput(z.uuid(), event).toLowerCase(),
      page,
    );
  }
  @Post(':id/refund')
  @HttpCode(202)
  async request(
    @Headers('authorization') auth: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('organizationId') org: string,
    @Param('eventId') event: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const actor = await this.actor(auth);
    return this.refunds.request(
      actor,
      parseInput(z.uuid(), org).toLowerCase(),
      parseInput(z.uuid(), event).toLowerCase(),
      parseInput(z.uuid(), id).toLowerCase(),
      key,
      body,
    );
  }
}
