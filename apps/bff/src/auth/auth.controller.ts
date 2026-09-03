import { Controller, Get, Inject, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiError } from '@eventflow/service-runtime';
import { AuthService } from './auth.service';
import { opaqueId } from './session-store';
import { safeReturnTo } from './config';

@Controller('api/v1/auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Get('login')
  async login(
    @Req() request: Request,
    @Query('returnTo') returnTo: unknown,
    @Res() response: Response,
  ) {
    await this.auth.store.rateLimit(`login:${request.socket.remoteAddress}`, 20);
    const flow = {
      verifier: opaqueId(),
      nonce: opaqueId(),
      state: opaqueId(),
      returnTo: safeReturnTo(returnTo),
    };
    const url = await this.auth.identity.authorize(flow);
    const id = await this.auth.store.startFlow(flow);
    response.setHeader('cache-control', 'no-store');
    response.setHeader('set-cookie', this.auth.cookie('flow', id, 300));
    response.redirect(302, url.href);
  }

  @Get('callback')
  async callback(@Req() request: Request, @Res() response: Response) {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('set-cookie', this.auth.cookie('flow', '', 0));
    const id = this.auth.readCookie(request, 'flow');
    const flow = id ? await this.auth.store.takeFlow(id) : null;
    if (!flow) throw new ApiError(400, 'LOGIN_EXPIRED', 'Запрос входа истёк. Начните заново.');
    const session = await this.auth.identity.exchange(
      new URL(request.originalUrl, this.auth.config.PUBLIC_ORIGIN),
      flow,
    );
    const old = this.auth.readCookie(request, 'session');
    if (old) await this.auth.store.destroy(old);
    const sessionId = await this.auth.store.create(session);
    response.setHeader('set-cookie', [
      this.auth.cookie('flow', '', 0),
      this.auth.cookie('session', sessionId, 28800),
    ]);
    response.redirect(303, flow.returnTo);
  }

  @Get('session')
  async session(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    response.setHeader('cache-control', 'no-store');
    if (!this.auth.readCookie(request, 'session')) return { user: null };
    try {
      const { session } = await this.auth.requireSession(request);
      return { user: session.user, csrfToken: session.csrf };
    } catch (error) {
      if (error instanceof ApiError && error.getStatus() === 401) {
        response.setHeader('set-cookie', this.auth.cookie('session', '', 0));
        return { user: null };
      }
      throw error;
    }
  }

  @Post('logout')
  async logout(@Req() request: Request, @Res() response: Response) {
    const { id, session } = await this.auth.requireSession(request);
    this.auth.assertCsrf(request, session.csrf);
    // Local revocation is unconditional, including an unavailable identity provider.
    await this.auth.store.destroy(id);
    response.setHeader('set-cookie', this.auth.cookie('session', '', 0));
    response.setHeader('cache-control', 'no-store');
    response.status(200).json({ logoutUrl: await this.auth.identity.logoutUrl() });
  }
}
