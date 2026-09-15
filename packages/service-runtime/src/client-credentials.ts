import { z } from 'zod';

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive(),
});

export class ClientCredentials {
  private cached: { token: string; refreshAt: number } | undefined;

  constructor(
    private readonly issuer: string,
    private readonly clientId: string,
    private readonly secret: string,
  ) {}

  async token() {
    if (this.cached && this.cached.refreshAt > Date.now()) return this.cached.token;
    const response = await fetch(`${this.issuer}/protocol/openid-connect/token`, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(3000),
      body: new URLSearchParams({
        client_id: this.clientId,
        grant_type: 'client_credentials',
        client_secret: this.secret,
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Machine identity unavailable');
    }
    const token = tokenSchema.parse(await response.json());
    this.cached = {
      token: token.access_token,
      refreshAt: Date.now() + Math.max(0, token.expires_in - 30) * 1000,
    };
    return this.cached.token;
  }
}
