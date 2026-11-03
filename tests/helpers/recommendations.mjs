import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

async function availablePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
export async function recommendationsFixture(catalog, namespace) {
  const name = 'eventflow_recommendations_e2e_' + randomUUID().replaceAll('-', ''),
    admin = new pg.Client({ connectionString: process.env.RECOMMENDATIONS_ADMIN_DATABASE_URL });
  await admin.connect();
  await admin.query('CREATE DATABASE "' + name + '" OWNER recommendations');
  const database = new URL(process.env.RECOMMENDATIONS_DATABASE_URL);
  database.pathname = '/' + name;
  const adminDatabase = new URL(process.env.RECOMMENDATIONS_ADMIN_DATABASE_URL);
  adminDatabase.pathname = '/' + name;
  const owner = new pg.Client({ connectionString: adminDatabase.href });
  await owner.connect();
  try {
    await owner.query('CREATE EXTENSION vector');
  } finally {
    await owner.end();
  }
  const port = await availablePort(),
    children = [];
  let telemetryVersion = randomBytes(20).toString('hex');
  const env = {
    ...process.env,
    RECOMMENDATIONS_DATABASE_URL: database.href,
    CATALOG_URL: catalog,
    MESSAGE_NAMESPACE: namespace,
    PORT: String(port),
    EVENTFLOW_BUILD_ID: telemetryVersion,
  };
  function start(command) {
    const child = spawn(process.execPath, ['scripts/recommendations.mjs', command], {
      cwd: resolve('.'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) => (output = (output + chunk).slice(-4000)));
    const closed = new Promise((done) => child.once('close', done)),
      record = { child, closed, output: () => output };
    children.push(record);
    return record;
  }
  async function stop(record) {
    if (record.child.exitCode !== null) return;
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(record.child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      await new Promise((done) => killer.once('close', done));
    } else record.child.kill('SIGTERM');
    const timer = setTimeout(() => record.child.kill('SIGKILL'), 5000);
    try {
      await record.closed;
    } finally {
      clearTimeout(timer);
    }
  }
  const client = new pg.Client({ connectionString: database.href });
  async function close() {
    for (const record of children.slice().reverse()) await stop(record);
    await client.end();
    await admin.query('DROP DATABASE IF EXISTS "' + name + '" WITH (FORCE)');
    await admin.end();
  }
  try {
    const migration = start('migrate');
    await migration.closed;
    if (migration.child.exitCode !== 0)
      throw new Error('Recommendations migration failed: ' + migration.output());
    await client.connect();
    const api = start('api'),
      origin = 'http://127.0.0.1:' + port;
    let worker = start('worker');
    const deadline = Date.now() + 60000;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      for (const record of [api, worker])
        if (record.child.exitCode !== null)
          throw new Error('Recommendations stopped: ' + record.output());
      try {
        const r = await fetch(origin + '/health/ready', { signal: AbortSignal.timeout(1000) });
        ready = r.ok;
        await r.body?.cancel();
      } catch {
        /* The API can still be starting. */
      }
      if (!ready) await delay(200);
    }
    if (!ready) throw new Error('Recommendations startup timed out');
    return {
      origin,
      get telemetryVersion() {
        return telemetryVersion;
      },
      client,
      databaseUrl: database.href,
      close,
      stopApi: () => stop(api),
      stopWorker: () => stop(worker),
      startWorker: () => {
        if (worker.child.exitCode === null) throw new Error('Worker is running');
        telemetryVersion = randomBytes(20).toString('hex');
        env.EVENTFLOW_BUILD_ID = telemetryVersion;
        worker = start('worker');
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
