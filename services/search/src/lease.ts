import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';

export class ProjectionBusy extends Error {}
export type WriteLease = { assert(): Promise<void> };
export class ProjectionLease {
  readonly client;
  constructor(
    url: string,
    readonly namespace: string,
  ) {
    this.client = createClient({
      url,
      disableOfflineQueue: true,
      socket: { connectTimeout: 3000 },
    });
    this.client.on('error', () => {
      /* Failed commands abort the operation; tokens expire. */
    });
  }
  async connect() {
    await this.client.connect();
  }
  async run<T>(
    operation: (lease: WriteLease) => Promise<T>,
    kind: 'writer' | 'rebuild' = 'writer',
  ): Promise<T> {
    const key = this.namespace + ':' + kind,
      token = randomUUID();
    if (
      !(await this.client
        .withCommandOptions({ timeout: 2000 })
        .set(key, token, { NX: true, expiration: { type: 'PX', value: 30000 } }))
    )
      throw new ProjectionBusy('Search projection is busy');
    let lost = false;
    const renew = async () => {
      const renewed = await this.client
        .withCommandOptions({ timeout: 2000 })
        .eval(
          "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('PEXPIRE',KEYS[1],30000) else return 0 end",
          { keys: [key], arguments: [token] },
        );
      if (renewed !== 1) lost = true;
      if (lost) throw new ProjectionBusy('Search lease expired');
    };
    const timer = setInterval(() => {
      void renew().catch(() => {
        lost = true;
      });
    }, 5000);
    try {
      return await operation({
        assert: async () => {
          if (lost) throw new ProjectionBusy('Search lease expired');
          await renew();
        },
      });
    } finally {
      clearInterval(timer);
      await this.client
        .withCommandOptions({ timeout: 2000 })
        .eval(
          "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end",
          { keys: [key], arguments: [token] },
        )
        .catch(() => {});
    }
  }
  onApplicationShutdown() {
    if (this.client.isOpen) this.client.destroy();
  }
}
