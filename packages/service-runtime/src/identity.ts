import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';
import { ApiError } from './http';

export type UserIdentity = { subject: string; email: string; emailVerified: boolean; name: string };
export class TokenVerifier {
  private readonly keys;
  constructor(
    private readonly issuer: string,
    private readonly audience: string,
  ) {
    const url = new URL(issuer);
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))
    )
      throw new Error('Invalid issuer transport');
    this.keys = createRemoteJWKSet(new URL(`${issuer}/protocol/openid-connect/certs`), {
      timeoutDuration: 2000,
    });
  }
  private async verify(authorization: string | undefined): Promise<JWTPayload> {
    const match = authorization?.match(/^Bearer ([A-Za-z0-9_.-]+)$/);
    if (!match?.[1]) throw new ApiError(401, 'UNAUTHENTICATED', 'Войдите в аккаунт.');
    try {
      const { payload } = await jwtVerify(match[1], this.keys, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ['RS256'],
        requiredClaims: ['sub', 'iat', 'exp'],
      });
      return payload;
    } catch (error) {
      if (error instanceof errors.JOSEError && !(error instanceof errors.JWKSTimeout))
        throw new ApiError(401, 'UNAUTHENTICATED', 'Недействительный токен.');
      throw new ApiError(
        503,
        'IDENTITY_UNAVAILABLE',
        'Проверка учётной записи временно недоступна.',
      );
    }
  }
  async user(authorization: string | undefined): Promise<UserIdentity> {
    const claims = await this.verify(authorization);
    if (claims.azp !== 'eventflow-bff' || !claims.sub || !z.email().safeParse(claims.email).success)
      throw new ApiError(401, 'UNAUTHENTICATED', 'Требуется пользовательская учётная запись.');
    return {
      subject: claims.sub,
      email: String(claims.email).trim().toLowerCase(),
      emailVerified: claims.email_verified === true,
      name: typeof claims.name === 'string' ? claims.name : String(claims.email),
    };
  }
  async machine(authorization: string | undefined) {
    const claims = await this.verify(authorization);
    const roles = z.object({ roles: z.array(z.string()) }).safeParse(claims.realm_access);
    if (
      claims.azp !== 'eventflow-policy' ||
      !roles.success ||
      !roles.data.roles.includes('policy-check')
    )
      throw new ApiError(403, 'FORBIDDEN', 'Требуется служебное полномочие.');
    return { subject: claims.sub };
  }
}
