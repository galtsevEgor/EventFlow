import { createHash, randomBytes } from 'node:crypto';
import { createClient } from 'redis';
import { z } from 'zod';
import { ApiError } from '@eventflow/service-runtime';
import type { AuthConfig } from './config';

export const opaqueId = () => randomBytes(32).toString('base64url');
export const identitySchema = z.object({
  sub: z.string().min(1),
  email: z.email(),
  emailVerified: z.boolean(),
  name: z.string(),
});
export const sessionSchema = z.object({
  user: identitySchema,
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  idToken: z.string().min(1),
  csrf: z.string().min(32),
  accessExpiresAt: z.number(),
  absoluteExpiresAt: z.number(),
});
export type Session = z.infer<typeof sessionSchema>;
const flowSchema = z.object({
  verifier: z.string(),
  nonce: z.string(),
  state: z.string(),
  returnTo: z.string(),
});
export type LoginFlow = z.infer<typeof flowSchema>;

export class SessionStore {
  readonly client;
  constructor(private readonly config: AuthConfig) {
    this.client = createClient({
      url: config.REDIS_URL,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 2000,
        reconnectStrategy: (retries) => Math.min(100 * (retries + 1), 2000),
      },
    });
    this.client.on('error', () => {
      /* Redis errors are converted into safe 503 responses at the boundary. */
    });
  }
  async onModuleInit() {
    await this.client.connect();
  }
  async onModuleDestroy() {
    if (this.client.isOpen) this.client.destroy();
  }
  key(kind: string, id: string) {
    return `${this.config.SESSION_PREFIX}${kind}:${createHash('sha256').update(id).digest('hex')}`;
  }
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (!this.client.isReady)
      throw new ApiError(503, 'SESSION_UNAVAILABLE', 'Сессия временно недоступна.');
    try {
      return await operation();
    } catch {
      throw new ApiError(503, 'SESSION_UNAVAILABLE', 'Сессия временно недоступна.');
    }
  }
  async startFlow(flow: LoginFlow) {
    const id = opaqueId();
    await this.execute(() =>
      this.client.set(this.key('flow', id), JSON.stringify(flow), {
        expiration: { type: 'EX', value: 300 },
      }),
    );
    return id;
  }
  async takeFlow(id: string) {
    const raw = await this.execute(() => this.client.getDel(this.key('flow', id)));
    return raw ? flowSchema.parse(JSON.parse(raw)) : null;
  }
  async create(session: Session) {
    const id = opaqueId();
    await this.execute(() =>
      this.client.set(this.key('session', id), JSON.stringify(session), {
        expiration: { type: 'EX', value: 1800 },
      }),
    );
    return id;
  }
  async read(id: string) {
    if (!/^[\w-]{43}$/.test(id)) return null;
    const raw = await this.execute(() => this.client.get(this.key('session', id)));
    if (!raw) return null;
    const session = sessionSchema.parse(JSON.parse(raw));
    if (session.absoluteExpiresAt <= Date.now()) {
      await this.destroy(id);
      return null;
    }
    return { raw, session };
  }
  async replace(id: string, previous: string, session: Session) {
    const ttl = Math.min(1800000, session.absoluteExpiresAt - Date.now());
    if (ttl <= 0) return false;
    const result = await this.execute(() =>
      this.client.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3]); return 1 end; return 0",
        {
          keys: [this.key('session', id)],
          arguments: [previous, JSON.stringify(session), String(ttl)],
        },
      ),
    );
    return result === 1;
  }
  async destroy(id: string) {
    await this.execute(() => this.client.del(this.key('session', id)));
  }
  async acquireRefresh(id: string, owner: string) {
    return (
      (await this.execute(() =>
        this.client.set(this.key('refresh', id), owner, {
          condition: 'NX',
          expiration: { type: 'PX', value: 10000 },
        }),
      )) === 'OK'
    );
  }
  async releaseRefresh(id: string, owner: string) {
    await this.execute(() =>
      this.client.eval(
        "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end; return 0",
        { keys: [this.key('refresh', id)], arguments: [owner] },
      ),
    );
  }
  async rateLimit(identity: string, limit: number) {
    const count = await this.execute(() =>
      this.client.eval(
        "local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], 60) end; return n",
        { keys: [this.key('rate', identity)], arguments: [] },
      ),
    );
    if (Number(count) > limit)
      throw new ApiError(429, 'RATE_LIMITED', 'Слишком много запросов. Повторите через минуту.');
  }
}
