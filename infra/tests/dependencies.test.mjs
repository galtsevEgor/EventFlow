import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';
import { createClient } from 'redis';
import { connect } from 'amqplib';
import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteBucketCommand,
} from '@aws-sdk/client-s3';

test('each service can use its database but cannot connect to another service database', async () => {
  const names = ['catalog', 'booking', 'payments', 'tickets'];
  for (const name of names) {
    const url = new URL(process.env[`${name.toUpperCase()}_DATABASE_URL`]);
    const client = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 5000 });
    await client.connect();
    try {
      const {
        rows: [role],
      } = await client.query(
        'SELECT current_user, rolsuper, rolcreatedb FROM pg_roles WHERE rolname = current_user',
      );
      assert.equal(role.current_user, name);
      assert.equal(role.rolsuper, false);
      assert.equal(role.rolcreatedb, false);
      await client.query('BEGIN');
      await client.query('CREATE TABLE environment_probe (id integer PRIMARY KEY)');
      await client.query('INSERT INTO environment_probe VALUES (1)');
      await client.query('ROLLBACK');
    } finally {
      await client.end();
    }
    for (const other of names.filter((other) => other !== name)) {
      const forbidden = new URL(url);
      forbidden.pathname = `/${other}`;
      const denied = new pg.Client({
        connectionString: forbidden.href,
        connectionTimeoutMillis: 5000,
      });
      try {
        await assert.rejects(denied.connect(), { code: '42501' });
      } finally {
        await denied.end();
      }
    }
  }
});

test('Redis accepts authenticated expiring data', async () => {
  const client = createClient({
    url: process.env.REDIS_URL,
    socket: { connectTimeout: 5000, reconnectStrategy: false },
  });
  client.on('error', () => {});
  await client.connect();
  const key = `eventflow:probe:${randomUUID()}`;
  try {
    await client.set(key, 'ready', { expiration: { type: 'EX', value: 30 } });
    assert.equal(await client.get(key), 'ready');
    assert.ok((await client.ttl(key)) > 0);
  } finally {
    await client.del(key);
    await client.close();
  }
});

test('RabbitMQ confirms publishing and delivers a message', async () => {
  const connection = await connect(process.env.AMQP_URL, { timeout: 5000 });
  try {
    const channel = await connection.createConfirmChannel();
    const { queue } = await channel.assertQueue('', { exclusive: true });
    channel.sendToQueue(queue, Buffer.from('ready'));
    await channel.waitForConfirms();
    const message = await channel.get(queue);
    assert.ok(message);
    assert.equal(message.content.toString(), 'ready');
    channel.ack(message);
    await channel.close();
  } finally {
    await connection.close();
  }
});

test('S3 requires authentication and stores an object through its signed API', async () => {
  const endpoint = process.env.S3_ENDPOINT;
  assert.equal((await fetch(endpoint, { signal: AbortSignal.timeout(5000) })).status, 403);
  const client = new S3Client({
    endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY,
      secretAccessKey: process.env.S3_SECRET_KEY,
    },
  });
  const Bucket = `eventflow-probe-${randomUUID()}`;
  const Key = 'probe.txt';
  await client.send(new CreateBucketCommand({ Bucket }));
  try {
    await client.send(new PutObjectCommand({ Bucket, Key, Body: 'ready' }));
    const object = await client.send(new GetObjectCommand({ Bucket, Key }));
    assert.equal(await object.Body.transformToString(), 'ready');
  } finally {
    await client.send(new DeleteObjectCommand({ Bucket, Key }));
    await client.send(new DeleteBucketCommand({ Bucket }));
    client.destroy();
  }
});

test('Keycloak publishes OIDC discovery and Mailpit accepts API requests', async () => {
  const oidc = await fetch(
    `${process.env.KEYCLOAK_URL}/realms/master/.well-known/openid-configuration`,
    { signal: AbortSignal.timeout(10000) },
  );
  assert.equal(oidc.status, 200);
  assert.equal((await oidc.json()).issuer, `${process.env.KEYCLOAK_URL}/realms/master`);
  const mail = await fetch(`${process.env.MAILPIT_URL}/api/v1/messages`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(mail.status, 200);
  assert.ok(Array.isArray((await mail.json()).messages));
});
