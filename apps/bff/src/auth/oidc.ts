import * as oidc from 'openid-client';
import { ApiError } from '@eventflow/service-runtime';
import type { AuthConfig } from './config';
import { identitySchema, type LoginFlow, type Session } from './session-store';

export class IdentityProvider {
  private configuration: Promise<oidc.Configuration> | undefined;
  constructor(private readonly config: AuthConfig) {}
  async getConfiguration() {
    this.configuration ??= oidc.discovery(
      new URL(this.config.OIDC_ISSUER),
      this.config.OIDC_CLIENT_ID,
      this.config.OIDC_CLIENT_SECRET,
      oidc.ClientSecretPost(this.config.OIDC_CLIENT_SECRET),
      {
        timeout: 5,
        execute: [
          oidc.enableNonRepudiationChecks,
          ...(this.config.OIDC_ISSUER.startsWith('http:') ? [oidc.allowInsecureRequests] : []),
        ],
      },
    );
    try {
      return await this.configuration;
    } catch {
      this.configuration = undefined;
      throw new ApiError(
        503,
        'IDENTITY_UNAVAILABLE',
        'Вход временно недоступен. Попробуйте позже.',
      );
    }
  }
  async authorize(flow: LoginFlow) {
    return oidc.buildAuthorizationUrl(await this.getConfiguration(), {
      scope: 'openid email profile',
      redirect_uri: `${this.config.PUBLIC_ORIGIN}/api/v1/auth/callback`,
      code_challenge: await oidc.calculatePKCECodeChallenge(flow.verifier),
      code_challenge_method: 'S256',
      state: flow.state,
      nonce: flow.nonce,
    });
  }
  async exchange(url: URL, flow: LoginFlow): Promise<Session> {
    const config = await this.getConfiguration();
    let tokens;
    try {
      tokens = await oidc.authorizationCodeGrant(config, url, {
        pkceCodeVerifier: flow.verifier,
        expectedNonce: flow.nonce,
        expectedState: flow.state,
        idTokenExpected: true,
      });
    } catch {
      throw new ApiError(400, 'LOGIN_FAILED', 'Не удалось завершить вход. Начните вход заново.');
    }
    const claims = tokens.claims();
    if (!claims || !tokens.refresh_token || !tokens.id_token || !tokens.expires_in)
      throw new ApiError(400, 'LOGIN_FAILED', 'Неполный ответ службы входа.');
    return {
      user: identitySchema.parse({
        sub: claims.sub,
        email: claims.email,
        emailVerified: claims.email_verified === true,
        name: typeof claims.name === 'string' ? claims.name : String(claims.email),
      }),
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      idToken: tokens.id_token,
      csrf: oidc.randomState(),
      accessExpiresAt: Date.now() + tokens.expires_in * 1000,
      absoluteExpiresAt: Date.now() + 28800000,
    };
  }
  async refresh(session: Session): Promise<Session> {
    try {
      const tokens = await oidc.refreshTokenGrant(
        await this.getConfiguration(),
        session.refreshToken,
      );
      const claims = tokens.claims();
      if (claims && claims.sub !== session.user.sub) throw new Error('Identity changed');
      if (!tokens.expires_in) throw new Error('Missing token expiry');
      return {
        ...session,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? session.refreshToken,
        idToken: tokens.id_token ?? session.idToken,
        accessExpiresAt: Date.now() + tokens.expires_in * 1000,
      };
    } catch (error) {
      if (error instanceof oidc.ResponseBodyError && error.error === 'invalid_grant')
        throw new ApiError(401, 'UNAUTHENTICATED', 'Сессия завершилась. Войдите снова.');
      throw new ApiError(
        503,
        'IDENTITY_UNAVAILABLE',
        'Не удалось обновить сессию. Повторите позже.',
      );
    }
  }
  async logoutUrl() {
    return oidc.buildEndSessionUrl(await this.getConfiguration(), {
      client_id: this.config.OIDC_CLIENT_ID,
      post_logout_redirect_uri: `${this.config.PUBLIC_ORIGIN}/`,
    }).href;
  }
}
