import { Body, Controller, Get, Headers, HttpCode, Inject, Post } from '@nestjs/common';
import { offlinePrepareSchema, offlineSyncSchema } from '@eventflow/event-contracts';
import { ApiError, parseInput, TokenVerifier } from '@eventflow/service-runtime';
import { AdmissionPolicy } from './admission-policy';
import { OfflineCheckIn } from './offline-check-in';

@Controller('api/v1/offline-check-in')
export class OfflineCheckInController {
  constructor(
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
    @Inject(AdmissionPolicy) private readonly policy: AdmissionPolicy,
    @Inject(OfflineCheckIn) private readonly offline: OfflineCheckIn,
  ) {}
  private async actor(authorization: string | undefined) {
    const actor = await this.verifier.user(authorization);
    if (!actor.emailVerified) throw new ApiError(403, 'EMAIL_UNVERIFIED', 'Подтвердите email.');
    return actor;
  }
  @Get('keys')
  async keys(@Headers('authorization') authorization: string | undefined) {
    await this.actor(authorization);
    return this.offline.keys();
  }
  @Post('sessions')
  @HttpCode(200)
  async prepare(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ) {
    const actor = await this.actor(authorization);
    const input = parseInput(offlinePrepareSchema, body);
    const window = await this.policy.window(actor.subject, input);
    return this.offline.prepare(actor.subject, input, window);
  }
  @Post('sync')
  @HttpCode(200)
  async sync(@Headers('authorization') authorization: string | undefined, @Body() body: unknown) {
    const actor = await this.actor(authorization);
    const input = parseInput(offlineSyncSchema, body);
    const session = await this.offline.session(actor.subject, input.sessionId, input.deviceId);
    const window = await this.policy.window(actor.subject, session);
    return this.offline.sync(actor.subject, input, window);
  }
}
