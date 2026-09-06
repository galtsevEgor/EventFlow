import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Module } from '@nestjs/common';
import { createApplication } from '@eventflow/service-runtime';
import { PaymentWebhooksController } from '../dist/payment-webhooks.controller.js';
import { AUTH_CONFIG } from '../dist/auth/config.js';

test('BFF forwards exact webhook bytes and signature without browser credentials; only durable upstream success is acknowledged', async () => {
  const received = [];
  let status = 200;
  const provider = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ headers: req.headers, body: Buffer.concat(chunks), path: req.url });
    res.setHeader('content-type', 'application/json');
    res.statusCode = status;
    res.end(JSON.stringify({ received: status === 200 }));
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  class WebhookTestModule {}
  Module({
    controllers: [PaymentWebhooksController],
    providers: [
      {
        provide: AUTH_CONFIG,
        useValue: { PAYMENTS_URL: `http://127.0.0.1:${provider.address().port}` },
      },
    ],
  })(WebhookTestModule);
  const app = await createApplication(WebhookTestModule, { rawBody: true });
  try {
    await app.listen(0, '127.0.0.1');
    const endpoint = `${await app.getUrl()}/api/v1/webhooks/stripe`;
    const raw = '{ "id": "evt_fixture",\n "label": "Платёж", "data": { "amount": 1500 } }\n';
    const headers = {
      'content-type': 'application/json',
      'stripe-signature': 'synthetic-signature',
      authorization: 'Bearer must-not-forward',
      cookie: 'session=must-not-forward',
    };
    const send = () => fetch(endpoint, { method: 'POST', headers, body: raw });
    assert.equal((await send()).status, 200);
    assert.deepEqual(received[0].body, Buffer.from(raw));
    assert.equal(received[0].path, '/api/v1/webhooks/stripe');
    assert.equal(received[0].headers['stripe-signature'], headers['stripe-signature']);
    assert.equal(received[0].headers.authorization, undefined);
    assert.equal(received[0].headers.cookie, undefined);
    status = 400;
    assert.equal((await send()).status, 400);
    status = 503;
    assert.equal((await send()).status, 503);
    assert.equal(
      (
        await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: raw,
        })
      ).status,
      400,
    );
    assert.equal((await fetch(endpoint)).status, 404);
    assert.equal(received.length, 3);
  } finally {
    await app.close();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
  }
});

test('public generated contract includes payments and the signed webhook but excludes operator endpoints', () => {
  const schema = JSON.parse(readFileSync(new URL('../openapi.json', import.meta.url), 'utf8'));
  assert.ok(schema.paths['/api/v1/orders/{id}/payment-attempt']);
  assert.deepEqual(schema.paths['/api/v1/webhooks/stripe'].post.security, []);
  assert.ok(Object.keys(schema.paths).every((path) => !path.startsWith('/internal/')));
});
