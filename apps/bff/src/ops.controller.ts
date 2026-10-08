import { Controller, Get, Inject, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ApiError, TokenVerifier } from '@eventflow/service-runtime';
import { AuthService } from './auth/auth.service';

@Controller('api/v1/ops')
export class OpsController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
  ) {}

  @Get('access')
  async access(@Req() request: Request) {
    const { session } = await this.auth.requireSession(request);
    const actor = await this.verifier.operator(`Bearer ${session.accessToken}`);
    if (actor.subject !== session.user.sub)
      throw new ApiError(401, 'UNAUTHENTICATED', 'Сессия завершилась.');
    return { canRecover: actor.canRecover };
  }
}
