import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { parseInput } from './http';
import { TokenVerifier } from './identity';
import { MailQueue } from './mail';

const operatorAudience = 'eventflow-mail-operator';
const retryPermission = 'mail-retry';

@Controller('internal/mail')
export class MailOperator {
  constructor(
    @Inject(MailQueue) private readonly queue: MailQueue,
    @Inject(TokenVerifier) private readonly verifier: TokenVerifier,
  ) {}

  @Get('dead')
  async dead(@Headers('authorization') auth: string | undefined) {
    await this.verifier.service(auth, operatorAudience, retryPermission);
    return { jobs: await this.queue.dead() };
  }

  @Post(':id/retry')
  @HttpCode(202)
  async retry(
    @Headers('authorization') auth: string | undefined,
    @Headers('idempotency-key') key: string | undefined,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const actor = await this.verifier.service(auth, operatorAudience, retryPermission);
    parseInput(z.strictObject({}), body ?? {});
    await this.queue.retry(
      parseInput(z.uuid(), id).toLowerCase(),
      parseInput(z.uuid(), key).toLowerCase(),
      actor.subject,
    );
    return { accepted: true };
  }
}
