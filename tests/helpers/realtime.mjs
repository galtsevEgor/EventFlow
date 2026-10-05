import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createClient } from 'redis';
import { createApplication } from '../../packages/service-runtime/dist/index.js';
import { AppModule } from '../../apps/bff/dist/app.module.js';
import { readAuthConfig } from '../../apps/bff/dist/auth/config.js';
import { SessionStore } from '../../apps/bff/dist/auth/session-store.js';
import { RealtimeBus } from '../../apps/bff/dist/realtime/bus.js';
import { RealtimeHub } from '../../apps/bff/dist/realtime/hub.js';
import { eventually } from './eventually.mjs';
import { cleanBroker } from './broker.mjs';

export async function realtimeFixture(overrides = {}, { snapshotSeats = 0, ...options } = {}) {
  const namespace = `eventflow-test-${randomUUID()}`,
    prefix = `realtime-test:${randomUUID()}:`;
  const saleId = randomUUID(),
    orderId = randomUUID(),
    organizationId = randomUUID();
  let managerAllowed = true;
  let revision = 0;
  let upstreamRequests = 0;
  const seats = Array.from({ length: snapshotSeats }, (_, i) => ({
    seatId: `r${Math.floor(i / 50) + 1}-s${(i % 50) + 1}`,
    row: Math.floor(i / 50) + 1,
    number: (i % 50) + 1,
    categoryId: 'standard',
    categoryName: 'Standard',
    priceMinor: 2500,
    state: 'AVAILABLE',
  }));
  const upstream = createServer((req, res) => {
    upstreamRequests++;
    req.resume();
    const token = req.headers.authorization;
    const allowed =
      req.url === `/api/v1/sales/${saleId}` ||
      req.url === `/api/v1/events/${saleId}` ||
      (req.url === `/api/v1/orders/${orderId}` && token === 'Bearer owner-token') ||
      (req.url ===
        `/internal/organizations/${organizationId}/events/${saleId}/order-updates-access` &&
        token === 'Bearer manager-token' &&
        managerAllowed);
    res.statusCode = allowed ? 200 : 404;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        revision,
        ...(snapshotSeats && req.url === `/api/v1/sales/${saleId}` ? { seats } : {}),
      }),
    );
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const config = readAuthConfig({
    ...process.env,
    SESSION_PREFIX: prefix,
    MESSAGE_NAMESPACE: namespace,
    BOOKING_URL: `http://127.0.0.1:${upstream.address().port}`,
    CATALOG_URL: `http://127.0.0.1:${upstream.address().port}`,
    REALTIME_HEARTBEAT_MS: '1000',
    REALTIME_USER_CONNECTIONS: '2',
    ...overrides,
  });
  const replicas = [];
  async function start() {
    const app = await createApplication(AppModule.configure(config), { name: 'bff', ...options });
    app.useLogger(false);
    await app.listen(0, '127.0.0.1');
    const replica = {
      app,
      origin: await app.getUrl(),
      bus: app.get(RealtimeBus),
      hub: app.get(RealtimeHub),
      store: app.get(SessionStore),
    };
    replicas.push(replica);
    await eventually(() => replica.bus.ready, Boolean);
    return replica;
  }
  async function close() {
    for (const replica of replicas) await replica.app.close();
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    const client = createClient({
      url: process.env.REDIS_URL,
      socket: { reconnectStrategy: false },
    });
    client.on('error', () => {});
    try {
      await client.connect();
      for (const pattern of [`${prefix}*`, `eventflow:updates:${namespace}:leases:*`])
        for await (const keys of client.scanIterator({ MATCH: pattern }))
          if (keys.length) await client.del(keys);
    } finally {
      if (client.isOpen) client.destroy();
    }
    await cleanBroker(namespace);
  }
  return {
    namespace,
    config,
    saleId,
    orderId,
    organizationId,
    start,
    close,
    replicas,
    revokeManager: () => {
      managerAllowed = false;
    },
    bump: () => ++revision,
    requests: () => upstreamRequests,
    async session(replica, sub = 'owner') {
      const id = await replica.store.create({
        user: { sub, email: `${sub}@eventflow.test`, emailVerified: true, name: sub },
        accessToken: `${sub}-token`,
        refreshToken: 'synthetic-refresh',
        idToken: 'synthetic-id',
        csrf: 'x'.repeat(43),
        accessExpiresAt: Date.now() + 600000,
        absoluteExpiresAt: Date.now() + 3600000,
      });
      return { id, cookie: `eventflow_session=${id}` };
    },
  };
}

export async function updatesStream(url, headers = {}) {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  const frames = [];
  let closed = false,
    buffer = '';
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  const running = (async () => {
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = event.split('\n').find((line) => line.startsWith('data: '));
          if (data) frames.push(JSON.parse(data.slice(6)));
          if (frames.length > 200) frames.shift();
        }
      }
    } catch {
      /* Disconnects are observable through closed and the next snapshot. */
    } finally {
      closed = true;
    }
  })();
  return {
    response,
    frames,
    get closed() {
      return closed;
    },
    wait: (kind, count = 1) =>
      eventually(
        () => frames.filter((frame) => frame.kind === kind).length,
        (n) => n >= count,
      ),
    async close() {
      controller.abort();
      await running;
    },
  };
}
