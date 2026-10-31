import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

test(
  'scanner worker verifies a signed 10000-ticket snapshot without blocking the page and rejects tampering',
  { timeout: 45000 },
  async () => {
    const filename = readdirSync('apps/organizer/dist/gate/assets').find((name) =>
      /^scanner\.worker-.*\.js$/.test(name),
    );
    assert.ok(filename);
    const source = readFileSync('apps/organizer/dist/gate/assets/' + filename);
    const server = createServer((req, res) => {
      if (req.url === '/organizer/gate/worker.js') {
        res.setHeader('content-type', 'text/javascript');
        res.end(source);
      } else {
        res.setHeader('content-type', 'text/html');
        res.end('<!doctype html><title>Gate worker fixture</title>');
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch();
    try {
      const keypair = generateKeyPairSync('ed25519'),
        jwk = keypair.publicKey.export({ format: 'jwk' });
      const context = {
        actorSubject: 'worker-fixture',
        organizationId: randomUUID(),
        eventId: randomUUID(),
        deviceId: randomUUID(),
      };
      const credential = 'z'.repeat(32),
        digest = (value) => createHash('sha256').update(value).digest('hex'),
        now = Date.now();
      const hashes = Array.from({ length: 9999 }, (_, i) => digest('fixture-' + i));
      hashes.push(digest(credential));
      const payload = JSON.stringify({
        version: 1,
        sessionId: randomUUID(),
        ...context,
        issuedAt: new Date(now - 1000).toISOString(),
        expiresAt: new Date(now + 60000).toISOString(),
        admissionStartsAt: new Date(now - 60000).toISOString(),
        admissionEndsAt: new Date(now + 3600000).toISOString(),
        hashes,
      });
      const keyId = digest(Buffer.from(jwk.x, 'base64url'));
      const bundle = {
        payload,
        keyId,
        signature: sign(null, Buffer.from(payload), keypair.privateKey).toString('base64url'),
      };
      const page = await browser.newPage();
      await page.goto('http://127.0.0.1:' + server.address().port + '/organizer/gate/');
      const result = await page.evaluate(
        async ({ bundle, jwk, context, credential, now }) => {
          const key = await crypto.subtle.importKey('jwk', jwk, 'Ed25519', false, ['verify']);
          const worker = new Worker('/organizer/gate/worker.js', { type: 'module' });
          let sequence = 0,
            beats = 0;
          const pending = new Map();
          worker.onmessage = (event) => {
            const task = pending.get(event.data.id);
            pending.delete(event.data.id);
            task?.(event.data);
          };
          const call = (data) =>
            new Promise((resolve) => {
              const id = ++sequence;
              pending.set(id, resolve);
              worker.postMessage({ id, ...data });
            });
          const started = performance.now(),
            timer = setInterval(() => beats++, 1);
          try {
            const initialized = await call({
              type: 'INIT',
              bundle,
              keyId: bundle.keyId,
              publicKey: key,
              context,
            });
            for (let i = 0; i < 100; i++) {
              const checked = await call({ type: 'CHECK', credential, now });
              if (checked.error) throw new Error(checked.error);
            }
            const tampered = await call({
              type: 'INIT',
              bundle: {
                ...bundle,
                payload: bundle.payload.replace('worker-fixture', 'another-actor'),
              },
              keyId: bundle.keyId,
              publicKey: key,
              context,
            });
            const expired = await call({ type: 'CHECK', credential, now: now + 60000 });
            return {
              count: initialized.value?.hashes.length,
              beats,
              milliseconds: performance.now() - started,
              tampered: tampered.error,
              expired: expired.error,
            };
          } finally {
            clearInterval(timer);
            worker.terminate();
          }
        },
        { bundle, jwk, context, credential, now },
      );
      assert.equal(result.count, 10000);
      assert.ok(result.beats > 0);
      assert.match(result.tampered, /Подпись/);
      assert.match(result.expired, /устарел/);
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
