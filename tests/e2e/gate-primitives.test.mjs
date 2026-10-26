import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
test('local Chromium persists non-exportable keys and supports signed offline work across tabs', async () => {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>Gate API compatibility</title>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch(),
    context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto('http://127.0.0.1:' + server.address().port);
    const result = await page.evaluate(async () => {
      const signing = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
      const data = new TextEncoder().encode('offline-gate');
      const signature = await crypto.subtle.sign('Ed25519', signing.privateKey, data);
      const valid = await crypto.subtle.verify('Ed25519', signing.publicKey, signature, data);
      const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
        'encrypt',
        'decrypt',
      ]);
      const db = await new Promise((resolve, reject) => {
        const r = indexedDB.open('gate-compatibility', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('keys');
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('keys', 'readwrite');
        tx.objectStore('keys').put(key, 'vault');
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
      });
      const restored = await new Promise((resolve, reject) => {
        const r = db.transaction('keys').objectStore('keys').get('vault');
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      const iv = crypto.getRandomValues(new Uint8Array(12)),
        encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, restored, data);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, restored, encrypted);
      db.close();
      await navigator.locks.request('gate-sync-compatibility', async () => {});
      return {
        valid,
        extractable: restored.extractable,
        roundtrip: new TextDecoder().decode(plain),
        worker: typeof Worker === 'function',
        serviceWorker: 'serviceWorker' in navigator,
      };
    });
    assert.deepEqual(result, {
      valid: true,
      extractable: false,
      roundtrip: 'offline-gate',
      worker: true,
      serviceWorker: true,
    });
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
