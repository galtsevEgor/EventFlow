import { createHash } from 'node:crypto';
import { SessionStore } from '../auth/session-store';
import type { AuthConfig } from '../auth/config';

const STREAM_LEASE_TTL_MS = 30_000;
const STREAM_LEASE_KEY_TTL_MS = 60_000;
const STREAM_QUOTA_COMMAND_TIMEOUT_MS = 2_000;
const leaseTtls = [String(STREAM_LEASE_TTL_MS), String(STREAM_LEASE_KEY_TTL_MS)];

export class StreamQuota {
  constructor(
    private readonly store: SessionStore,
    private readonly config: AuthConfig,
  ) {}
  private key(principal: string) {
    return `eventflow:updates:${this.config.MESSAGE_NAMESPACE}:leases:${createHash('sha256').update(principal).digest('hex')}`;
  }
  async acquire(principal: string, id: string) {
    const limit = principal.startsWith('user:')
      ? this.config.REALTIME_USER_CONNECTIONS
      : this.config.REALTIME_IP_CONNECTIONS;
    const result = await this.store.execute(() =>
      this.store.client.withCommandOptions({ timeout: STREAM_QUOTA_COMMAND_TIMEOUT_MS }).eval(
        `local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000)
       redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now)
       if redis.call('ZCARD',KEYS[1])>=tonumber(ARGV[4]) then return 0 end
       redis.call('ZADD',KEYS[1],now+tonumber(ARGV[2]),ARGV[1]); redis.call('PEXPIRE',KEYS[1],ARGV[3]); return 1`,
        { keys: [this.key(principal)], arguments: [id, ...leaseTtls, String(limit)] },
      ),
    );
    return result === 1;
  }
  async renew(principal: string, id: string) {
    const result = await this.store.execute(() =>
      this.store.client.withCommandOptions({ timeout: STREAM_QUOTA_COMMAND_TIMEOUT_MS }).eval(
        `local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000)
       local score=redis.call('ZSCORE',KEYS[1],ARGV[1]); if not score or tonumber(score)<=now then return 0 end
       redis.call('ZADD',KEYS[1],'XX',now+tonumber(ARGV[2]),ARGV[1]); redis.call('PEXPIRE',KEYS[1],ARGV[3]); return 1`,
        { keys: [this.key(principal)], arguments: [id, ...leaseTtls] },
      ),
    );
    return result === 1;
  }
  async release(principal: string, id: string) {
    await this.store
      .execute(() =>
        this.store.client
          .withCommandOptions({ timeout: STREAM_QUOTA_COMMAND_TIMEOUT_MS })
          .zRem(this.key(principal), id),
      )
      .catch(() => {});
  }
}
