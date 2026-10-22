import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { createClient } from 'redis';
import { cleanBroker } from '../helpers/broker.mjs';
import { bookingFixture } from '../helpers/booking.mjs';
import { paymentService } from '../helpers/payment-service.mjs';
import { ticketsService } from '../helpers/tickets-service.mjs';
import { createGateway } from '../../scripts/gateway.mjs';
import { analyticsFixture } from '../helpers/analytics.mjs';
import { searchEngineFixture } from '../helpers/opensearch.mjs';
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectCommand,
  DeleteBucketCommand,
} from '@aws-sdk/client-s3';

async function availablePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

export async function fullStack({
  booking = false,
  payments = false,
  tickets = false,
  search = false,
  analytics = false,
  gatewayLimits,
  httpConcurrency,
} = {}) {
  const database = `eventflow_e2e_${randomUUID().replaceAll('-', '')}`;
  const prefix = `e2e:${randomUUID()}:`;
  const namespace = `eventflow-test-${randomUUID()}`;
  const bucket = `eventflow-e2e-${randomUUID()}`;
  const admin = new pg.Client({
    host: '127.0.0.1',
    port: Number(new URL(process.env.CATALOG_DATABASE_URL).port || 5432),
    user: 'eventflow_admin',
    password: process.env.POSTGRES_ADMIN_PASSWORD,
    database: 'eventflow_admin',
  });
  await admin.connect();
  const children = [];
  let gateway;
  let bookingService;
  let paymentsService;
  let ticketsApp;
  let catalogOrigin;
  const bookingPort = await availablePort();
  const analyticsData = analytics ? await analyticsFixture() : undefined;
  const searchIndex = search ? searchEngineFixture() : undefined;
  async function startBooking() {
    bookingService ??= await bookingFixture(namespace, bookingPort, {
      CATALOG_URL: catalogOrigin ?? process.env.CATALOG_URL,
    });
    return bookingService;
  }
  async function startPayments() {
    const booking = await startBooking();
    paymentsService ??= await paymentService(
      namespace,
      booking.origin,
      typeof payments === 'object' ? payments : {},
    );
    return paymentsService;
  }
  async function close() {
    if (gateway) {
      gateway.closeAllConnections();
      await new Promise((done) => gateway.close(done));
    }
    await Promise.all(
      children.map(async ({ child, closed }) => {
        child.kill('SIGTERM');
        const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
        try {
          await closed;
        } finally {
          clearTimeout(deadline);
        }
      }),
    );
    const redis = createClient({
      url: process.env.REDIS_URL,
      socket: { reconnectStrategy: false },
    });
    redis.on('error', () => {});
    try {
      await redis.connect();
      for await (const keys of redis.scanIterator({ MATCH: `${prefix}*` }))
        if (keys.length) await redis.del(keys);
    } finally {
      if (redis.isOpen) await redis.quit();
    }
    await ticketsApp?.close();
    await searchIndex?.close();
    await analyticsData?.close();
    await paymentsService?.close();
    await bookingService?.close();
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
    await cleanBroker(namespace);
    const storage = new S3Client({
      endpoint: process.env.S3_ENDPOINT,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY,
        secretAccessKey: process.env.S3_SECRET_KEY,
      },
    });
    try {
      const objects = await storage.send(new ListObjectsV2Command({ Bucket: bucket }));
      for (const object of objects.Contents ?? [])
        await storage.send(new DeleteObjectCommand({ Bucket: bucket, Key: object.Key }));
      await storage.send(new DeleteBucketCommand({ Bucket: bucket }));
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'NoSuchBucket') throw error;
    } finally {
      storage.destroy();
    }
  }
  try {
    await admin.query(`CREATE DATABASE "${database}" OWNER catalog`);
    const dbUrl = new URL(process.env.CATALOG_DATABASE_URL);
    dbUrl.pathname = `/${database}`;
    const env = {
      ...process.env,
      CATALOG_DATABASE_URL: dbUrl.href,
      S3_COVERS_BUCKET: bucket,
      MESSAGE_NAMESPACE: namespace,
      SESSION_PREFIX: prefix,
      EVENTFLOW_LOG_REQUESTS: '0',
      NEXT_TELEMETRY_DISABLED: '1',
      ...(analyticsData
        ? {
            ANALYTICS_DATABASE_URL: analyticsData.env.ANALYTICS_DATABASE_URL,
            ANALYTICS_DATABASE: analyticsData.env.ANALYTICS_DATABASE,
          }
        : {}),
      ANALYTICS_ENABLED: analytics ? 'true' : 'false',
      SEARCH_ENABLED: search ? 'true' : 'false',
      SEARCH_INDEX_NAMESPACE: searchIndex?.namespace ?? process.env.SEARCH_INDEX_NAMESPACE,
      ...(httpConcurrency === undefined
        ? {}
        : { EVENTFLOW_HTTP_CONCURRENCY: String(httpConcurrency) }),
    };
    execFileSync(
      process.execPath,
      [
        'node_modules/prisma/build/index.js',
        'migrate',
        'deploy',
        '--config=services/catalog/prisma.config.ts',
      ],
      { env, stdio: 'pipe', windowsHide: true },
    );
    async function start(directory, args, health, extra = {}) {
      const port = await availablePort();
      const child = spawn(process.execPath, args(port), {
        cwd: resolve(directory),
        env: { ...env, ...extra, PORT: String(port), HOST: '127.0.0.1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const closed = new Promise((done) => child.once('close', done));
      children.push({ child, closed, directory });
      let output = '';
      for (const stream of [child.stdout, child.stderr])
        stream.on('data', (data) => {
          output = (output + data).slice(-4000);
        });
      const origin = `http://127.0.0.1:${port}`;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null) throw new Error(`${directory} stopped: ${output}`);
        try {
          const response = await fetch(origin + health, { signal: AbortSignal.timeout(1000) });
          await response.body?.cancel();
          if (response.ok) return origin;
        } catch {
          /* The process is still starting. */
        }
        await delay(200);
      }
      throw new Error(`${directory} startup timed out: ${output}`);
    }
    const catalog = await start('services/catalog', () => ['dist/main.js'], '/health/ready');
    catalogOrigin = catalog;
    const searchOrigin = search
      ? await start('services/search', () => ['dist/main.js'], '/health/ready', {
          CATALOG_URL: catalog,
        })
      : 'http://127.0.0.1:1';
    if (booking) await startBooking();
    if (payments) await startPayments();
    if (tickets)
      ticketsApp = await ticketsService(namespace, {
        BOOKING_URL: (await startBooking()).origin,
        CATALOG_URL: catalog,
        ...(typeof tickets === 'object' ? tickets : {}),
      });
    const analyticsOrigin = analytics
      ? await start('services/analytics', () => ['dist/main.js'], '/health/ready', {
          CATALOG_URL: catalog,
        })
      : 'http://127.0.0.1:1';
    const bff = await start('apps/bff', () => ['dist/main.js'], '/health/ready', {
      CATALOG_URL: catalog,
      SEARCH_URL: searchOrigin,
      ANALYTICS_URL: analyticsOrigin,
      BOOKING_URL: `http://127.0.0.1:${bookingPort}`,
      PAYMENTS_URL: paymentsService?.origin ?? 'http://127.0.0.1:1',
      TICKETS_URL: ticketsApp?.origin ?? 'http://127.0.0.1:1',
    });
    const storefront = await start(
      'apps/storefront',
      (port) => [
        'node_modules/next/dist/bin/next',
        'start',
        '--hostname',
        '127.0.0.1',
        '--port',
        String(port),
      ],
      '/',
      { CATALOG_URL: catalog, BFF_URL: bff },
    );
    const organizer = await start(
      'apps/organizer',
      (port) => [
        'node_modules/vite/bin/vite.js',
        'preview',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--strictPort',
      ],
      '/organizer/',
    );
    gateway = createGateway({ bff, storefront, organizer, limits: gatewayLimits });
    const origin = new URL(process.env.PUBLIC_ORIGIN);
    await new Promise((done, reject) => {
      gateway.once('error', reject);
      gateway.listen(Number(origin.port), '127.0.0.1', done);
    });
    return {
      origin: origin.origin,
      catalog,
      bff,
      analytics: analyticsData && { ...analyticsData, origin: analyticsOrigin },
      search: searchIndex && { origin: searchOrigin, engine: searchIndex.engine },
      catalogDatabase: database,
      close,
      startBooking,
      startPayments,
      tickets: ticketsApp,
      async stopCatalog() {
        const process = children.find((item) => item.directory === 'services/catalog');
        process.child.kill('SIGTERM');
        await process.closed;
      },
      async stopSearch() {
        const instance = children.find((item) => item.directory === 'services/search');
        if (!instance) throw new Error('Search fixture is disabled');
        instance.child.kill('SIGTERM');
        await instance.closed;
      },
      async stopBff() {
        const process = children.find((item) => item.directory === 'apps/bff');
        process.child.kill('SIGTERM');
        await process.closed;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
