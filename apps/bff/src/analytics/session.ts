import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
const sessionSchema = z.strictObject({ id: z.uuid(), expires: z.number().int().positive() });
export class AnalyticsSession {
  constructor(private readonly key: string) {}
  sign(value: unknown) {
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    return body + '.' + createHmac('sha256', this.key).update(body).digest('base64url');
  }
  verify(value: string) {
    const [body, signature, ...extra] = value.split('.');
    if (!body || !signature || extra.length || value.length > 20000) return null;
    const expected = createHmac('sha256', this.key).update(body).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) return null;
    try {
      return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown;
    } catch {
      return null;
    }
  }
  read(request: Pick<Request, 'headers'>) {
    const cookie = request.headers.cookie
      ?.split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith('eventflow_analytics='));
    const result = sessionSchema.safeParse(
      cookie ? this.verify(cookie.slice('eventflow_analytics='.length)) : null,
    );
    return result.success && result.data.expires > Date.now() ? result.data : null;
  }
  ensure(request: Request, response: Response) {
    const existing = this.read(request);
    if (existing) return existing.id;
    const value = { id: randomUUID(), expires: Date.now() + 24 * 3600000 };
    response.cookie('eventflow_analytics', this.sign(value), {
      httpOnly: true,
      sameSite: 'lax',
      secure: request.secure,
      path: '/',
      maxAge: 24 * 3600000,
    });
    return value.id;
  }
}
