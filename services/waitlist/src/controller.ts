import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import {
  ApiError,
  ClientCredentials,
  parseInput,
  requirePolicy,
  TokenVerifier,
} from '@eventflow/service-runtime';
import { WaitlistQueue } from './queue';
import type { WaitlistConfig } from './config';
export const CONFIG = Symbol('WAITLIST_CONFIG');
@Controller()
export class WaitlistController {
  constructor(
    @Inject(TokenVerifier) private readonly tokens: TokenVerifier,
    @Inject(WaitlistQueue) private readonly queue: WaitlistQueue,
    @Inject(ClientCredentials) private readonly policy: ClientCredentials,
    @Inject(CONFIG) private readonly config: WaitlistConfig,
  ) {}
  private id(value: string) {
    return parseInput(z.uuid(), value).toLowerCase();
  }
  private async user(auth: string | undefined) {
    const user = await this.tokens.user(auth);
    if (!user.emailVerified) throw new ApiError(403, 'EMAIL_UNVERIFIED', 'Подтвердите email.');
    return user;
  }
  private async published(saleId: string) {
    const r = await fetch(new URL('/api/v1/events/' + saleId, this.config.CATALOG_URL), {
      signal: AbortSignal.timeout(3000),
      redirect: 'error',
    });
    if (r.status === 404) throw new ApiError(404, 'NOT_FOUND', 'Мероприятие не найдено.');
    if (!r.ok) throw new ApiError(503, 'CATALOG_UNAVAILABLE', 'Каталог временно недоступен.');
    return z.object({ title: z.string() }).parse(await r.json());
  }
  @Get('api/v1/events/:id/waitlist')
  async info(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const saleId = this.id(id);
    await this.published(saleId);
    res.setHeader('cache-control', 'no-store');
    return this.queue.info(saleId);
  }
  @Post('api/v1/waitlist')
  @HttpCode(200)
  async join(@Headers('authorization') auth: string | undefined, @Body() input: unknown) {
    const user = await this.user(auth);
    const d = parseInput(
      z.strictObject({ saleId: z.uuid(), categoryId: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/) }),
      input,
    );
    await this.published(d.saleId);
    return this.queue.join(user.subject, user.email, d.saleId.toLowerCase(), d.categoryId);
  }
  @Get('api/v1/waitlist')
  async list(@Headers('authorization') auth: string | undefined) {
    return this.queue.list((await this.user(auth)).subject);
  }
  @Get('api/v1/waitlist/:id')
  async read(@Headers('authorization') auth: string | undefined, @Param('id') id: string) {
    return this.queue.read((await this.user(auth)).subject, this.id(id));
  }
  @Post('api/v1/waitlist/:id/cancel')
  @HttpCode(200)
  async cancel(@Headers('authorization') auth: string | undefined, @Param('id') id: string) {
    return this.queue.cancel((await this.user(auth)).subject, this.id(id));
  }
  private async authorize(auth: string | undefined, org: string, id: string) {
    const user = await this.user(auth);
    await requirePolicy(this.config.CATALOG_URL, await this.policy.token(), {
      actorSubject: user.subject,
      organizationId: org,
      eventId: id,
      action: 'events:write',
    });
  }
  @Get('api/v1/organizations/:org/events/:id/waitlist')
  async summary(
    @Headers('authorization') auth: string | undefined,
    @Param('org') org: string,
    @Param('id') id: string,
  ) {
    const organizationId = this.id(org),
      saleId = this.id(id);
    await this.authorize(auth, organizationId, saleId);
    return this.queue.summary(saleId);
  }
  @Put('api/v1/organizations/:org/events/:id/waitlist')
  async configure(
    @Headers('authorization') auth: string | undefined,
    @Param('org') org: string,
    @Param('id') id: string,
    @Body() input: unknown,
  ) {
    const organizationId = this.id(org),
      saleId = this.id(id),
      d = parseInput(z.strictObject({ enabled: z.boolean() }), input);
    await this.authorize(auth, organizationId, saleId);
    const event = await this.published(saleId);
    return this.queue.settings(saleId, organizationId, event.title, d.enabled);
  }
}
