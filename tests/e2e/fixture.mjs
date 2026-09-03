import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { createClient } from 'redis';
import { createGateway } from '../../scripts/gateway.mjs';

async function availablePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

export async function fullStack() {
  const database = `eventflow_e2e_${randomUUID().replaceAll('-', '')}`;
  const prefix = `e2e:${randomUUID()}:`;
  const admin = new pg.Client({
    host: '127.0.0.1',
    port: 15432,
    user: 'eventflow_admin',
    password: process.env.POSTGRES_ADMIN_PASSWORD,
    database: 'eventflow_admin',
  });
  await admin.connect();
  const children = [];
  let gateway;
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
    await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    await admin.end();
  }
  try {
    await admin.query(`CREATE DATABASE "${database}" OWNER catalog`);
    const dbUrl = new URL(process.env.CATALOG_DATABASE_URL);
    dbUrl.pathname = `/${database}`;
    const env = {
      ...process.env,
      CATALOG_DATABASE_URL: dbUrl.href,
      SESSION_PREFIX: prefix,
      EVENTFLOW_LOG_REQUESTS: '0',
      NEXT_TELEMETRY_DISABLED: '1',
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
      children.push({ child, closed });
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
    const bff = await start('apps/bff', () => ['dist/main.js'], '/health/ready', {
      CATALOG_URL: catalog,
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
    gateway = createGateway({ bff, storefront, organizer });
    const origin = new URL(process.env.PUBLIC_ORIGIN);
    await new Promise((done, reject) => {
      gateway.once('error', reject);
      gateway.listen(Number(origin.port), '127.0.0.1', done);
    });
    return { origin: origin.origin, close };
  } catch (error) {
    await close();
    throw error;
  }
}
