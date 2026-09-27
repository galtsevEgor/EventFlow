import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { UpdatesConnection } from '../dist/realtime/connection.js';

function response() {
  const res = new EventEmitter();
  res.destroyed = false;
  res.writableLength = 0;
  res.frames = [];
  res.status = () => res;
  res.set = () => res;
  res.flushHeaders = () => {};
  res.write = (frame) => {
    res.frames.push(frame);
    return true;
  };
  res.destroy = () => {
    res.destroyed = true;
    res.emit('close');
  };
  return res;
}
const metrics = () => ({
  opened: 1,
  closed: 0,
  changed: 0,
  heartbeats: 0,
  coalesced: 0,
  blocked: 0,
  slow: 0,
  authFailed: 0,
});
test('a slow consumer is disconnected once without buffering further notifications', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const res = response(),
    counts = metrics();
  let cleanup = 0;
  res.write = () => false;
  const connection = new UpdatesConnection(
    res,
    () => true,
    async () => true,
    () => cleanup++,
    counts,
  );
  connection.start(1000);
  for (let i = 0; i < 100; i++) connection.pulse();
  context.mock.timers.tick(200000);
  assert.equal(counts.slow, 1);
  assert.equal(counts.closed, 1);
  assert.equal(cleanup, 1);
  assert.equal(res.destroyed, true);
});
test('notification bursts remain bounded while authorization runs and revoked access sends no change', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const res = response(),
    counts = metrics();
  let checks = 0,
    release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const connection = new UpdatesConnection(
    res,
    () => true,
    async () => {
      checks++;
      await pending;
      throw new Error('Access revoked');
    },
    () => {},
    counts,
  );
  connection.start(1000);
  for (let i = 0; i < 1000; i++) connection.pulse();
  context.mock.timers.tick(200);
  await setImmediate();
  context.mock.timers.tick(10000);
  assert.equal(checks, 1);
  assert.equal(res.frames.length, 1);
  release();
  await setImmediate();
  assert.equal(res.destroyed, true);
  assert.equal(counts.authFailed, 1);
  assert.equal(counts.changed, 0);
  assert.ok(counts.coalesced >= 999);
});
