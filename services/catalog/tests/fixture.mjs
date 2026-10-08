import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createApplication } from '@eventflow/service-runtime';
import { AppModule } from '../dist/app.module.js';
import { Database } from '../dist/database.js';

export async function catalogFixture(overrides = {}) {
  const database = `eventflow_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({
    host: '127.0.0.1',
    port: Number(new URL(process.env.CATALOG_DATABASE_URL).port || 5432),
    user: 'eventflow_admin',
    password: process.env.POSTGRES_ADMIN_PASSWORD,
    database: 'eventflow_admin',
  });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${database}" OWNER catalog`);
  const url = new URL(process.env.CATALOG_DATABASE_URL);
  url.pathname = `/${database}`;
  let app, jwks;
  try {
    execFileSync(
      process.execPath,
      [
        'node_modules/prisma/build/index.js',
        'migrate',
        'deploy',
        '--config=services/catalog/prisma.config.ts',
      ],
      {
        env: { ...process.env, CATALOG_DATABASE_URL: url.href },
        stdio: 'pipe',
        windowsHide: true,
      },
    );
    const pair = await generateKeyPair('RS256');
    const key = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
    jwks = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ keys: [key] }));
    });
    await new Promise((done) => jwks.listen(0, '127.0.0.1', done));
    const issuer = `http://127.0.0.1:${jwks.address().port}`;
    app = await createApplication(
      AppModule.configure({
        OIDC_ISSUER: issuer,
        CATALOG_DATABASE_URL: url.href,
        CATALOG_INVITATION_KEY: process.env.CATALOG_INVITATION_KEY,
        PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN,
        MAILPIT_SMTP_PORT: Number(process.env.MAILPIT_SMTP_PORT),
        ...overrides,
      }),
    );
    app.useLogger(false);
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    return {
      origin,
      db: app.get(Database),
      async token(claims = {}, signingKey = pair.privateKey) {
        return new SignJWT({
          email: 'owner@eventflow.test',
          email_verified: true,
          name: 'Owner',
          azp: 'eventflow-bff',
          sub: 'test-owner',
          iss: issuer,
          aud: 'eventflow-catalog',
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 300,
          ...claims,
        })
          .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
          .sign(signingKey);
      },
      async request(path, token, method = 'GET', data, headers = {}) {
        const response = await fetch(`${origin}${path}`, {
          method,
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            'content-type': 'application/json',
            connection: 'close',
            ...headers,
          },
          ...(data === undefined ? {} : { body: JSON.stringify(data) }),
        });
        return { status: response.status, headers: response.headers, body: await response.json() };
      },
      async close() {
        await app.close();
        await new Promise((done) => jwks.close(done));
        await admin.query(`DROP DATABASE "${database}"`);
        await admin.end();
      },
    };
  } catch (error) {
    await app?.close();
    jwks?.close();
    await admin.query(`DROP DATABASE "${database}"`);
    await admin.end();
    throw error;
  }
}
