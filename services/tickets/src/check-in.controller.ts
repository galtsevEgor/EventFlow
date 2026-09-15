import { Body, Controller, Headers, HttpCode, Inject, Post } from '@nestjs/common';
import { checkInInput } from '@eventflow/event-contracts';
import { ApiError, parseInput, TokenVerifier } from '@eventflow/service-runtime';
import { AdmissionPolicy } from './admission-policy';
import { CheckInTicket } from './check-in';

@Controller('api/v1/check-in')
export class CheckInController {
  constructor(
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
    @Inject(AdmissionPolicy) private readonly policy: AdmissionPolicy,
    @Inject(CheckInTicket) private readonly checkIn: CheckInTicket,
  ) {}

  @Post()
  @HttpCode(200)
  async scan(@Headers('authorization') authorization: string | undefined, @Body() body: unknown) {
    const actor = await this.verifier.user(authorization);
    if (!actor.emailVerified) throw new ApiError(403, 'EMAIL_UNVERIFIED', 'Подтвердите email.');
    const input = parseInput(checkInInput, body);
    const window = await this.policy.window(actor.subject, input);
    return this.checkIn.run(actor.subject, input, window);
  }
}
