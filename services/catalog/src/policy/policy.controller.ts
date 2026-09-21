import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { ApiError, parseInput, TokenVerifier } from '@eventflow/service-runtime';
import { admissionWindowSchema } from '@eventflow/event-contracts';
import { PolicyService } from './policy.service';

const requestSchema = z.strictObject({
  actorSubject: z.string().min(1).max(128),
  organizationId: z.uuid(),
  eventId: z.uuid().optional(),
  action: z.enum(['events:read', 'events:write', 'members:manage', 'check-in', 'orders:refund']),
});
@Controller('internal/policy')
export class PolicyController {
  constructor(
    @Inject(PolicyService) private readonly policy: PolicyService,
    @Inject(TokenVerifier) private readonly tokens: TokenVerifier,
  ) {}
  @Post('check') @HttpCode(200) async check(@Req() request: Request, @Body() body: unknown) {
    await this.tokens.machine(request.header('authorization'));
    return this.policy.check(parseInput(requestSchema, body));
  }
  @Post('admission')
  @HttpCode(200)
  async admission(@Req() request: Request, @Body() body: unknown) {
    await this.tokens.machine(request.header('authorization'));
    const scope = parseInput(
      requestSchema.omit({ action: true }).extend({ eventId: z.uuid() }),
      body,
    );
    const snapshot = await this.policy.admission(scope);
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot))
      throw new ApiError(403, 'FORBIDDEN', 'Допуск для этого мероприятия недоступен.');
    return admissionWindowSchema.parse({
      admissionStartsAt: snapshot.admissionStartsAt,
      admissionEndsAt: snapshot.admissionEndsAt,
    });
  }
}
