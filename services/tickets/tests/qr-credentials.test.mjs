import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { QrCredentials } from '../dist/qr-credentials.js';

test('QR credentials are random, hashed separately and encrypted against the ticket ID', () => {
  const keys = new QrCredentials(`v1:${randomBytes(32).toString('hex')}`);
  const id = randomUUID();
  const ticket = { id, ...keys.issue(id) };
  const credential = keys.reveal(ticket);
  assert.ok(/^[A-Za-z0-9_-]{32}$/.test(credential));
  assert.ok(!ticket.qrEncrypted.includes(Buffer.from(credential)));
  assert.equal(ticket.qrHash, createHash('sha256').update(credential).digest('hex'));
  assert.notEqual(ticket.qrHash, keys.issue(id).qrHash);
  assert.throws(() => keys.reveal({ ...ticket, id: randomUUID() }));
  const tampered = Buffer.from(ticket.qrEncrypted);
  tampered[16] ^= 1;
  assert.throws(() => keys.reveal({ ...ticket, qrEncrypted: tampered }));
});

test('rotation uses the first key for new tickets and retains readability of older tickets', () => {
  const oldKey = `v1:${randomBytes(32).toString('hex')}`;
  const newKey = `v2:${randomBytes(32).toString('hex')}`;
  const original = new QrCredentials(oldKey);
  const id = randomUUID();
  const old = { id, ...original.issue(id) };
  const rotated = new QrCredentials(`${newKey},${oldKey}`);
  assert.equal(rotated.issue(id).qrKeyId, 'v2');
  assert.ok(rotated.reveal(old) === original.reveal(old));
  assert.throws(() => new QrCredentials(newKey).reveal(old), /key unavailable/);
  assert.throws(() => new QrCredentials(`${oldKey},${oldKey}`), /Invalid ticket QR keyring/);
  assert.throws(() => new QrCredentials(''), /Invalid ticket QR keyring/);
});
