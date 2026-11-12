import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { liveQueryPollInterval, watchUpdates } from '../dist/index.js';

class Source extends EventTarget {
  closed = false;
  onerror = null;
  close() {
    this.closed = true;
  }
  emit(kind, extra = {}) {
    this.dispatchEvent(new MessageEvent('update', { data: JSON.stringify({ kind, ...extra }) }));
  }
}
const path = `/api/v1/orders/${randomUUID()}/updates`;
test('waitlist subscriptions use the same validated SSE client', () => {
  const source = new Source(),
    states = [];
  const stop = watchUpdates('/api/v1/waitlist/' + randomUUID() + '/updates', {
    createSource: () => source,
    onConnection: (value) => states.push(value),
    onUpdate: async () => {},
  });
  source.emit('ready');
  assert.deepEqual(states, [false, true]);
  stop();
  assert.equal(source.closed, true);
});

test('ready reloads the snapshot and coalesces bursts behind an in-flight read', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const source = new Source(),
    states = [];
  let count = 0,
    release;
  const first = new Promise((resolve) => {
    release = resolve;
  });
  const stop = watchUpdates(path, {
    createSource: () => source,
    onConnection: (value) => states.push(value),
    onUpdate: () => {
      count++;
      return count === 1 ? first : Promise.resolve();
    },
  });
  source.emit('ready');
  context.mock.timers.tick(100);
  await setImmediate();
  assert.equal(count, 1);
  for (let i = 0; i < 30; i++) source.emit('changed');
  context.mock.timers.tick(100);
  await setImmediate();
  assert.equal(count, 1);
  release();
  await setImmediate();
  context.mock.timers.tick(100);
  await setImmediate();
  assert.equal(count, 2);
  source.emit('heartbeat');
  context.mock.timers.tick(100);
  await setImmediate();
  assert.equal(count, 2);
  assert.deepEqual(states, [false, true]);
  stop();
  assert.equal(source.closed, true);
});

test('lost connections and silent streams fall back and reconnect with a fresh snapshot', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const sources = [],
    states = [];
  let reads = 0;
  const stop = watchUpdates(path, {
    createSource: () => {
      const source = new Source();
      sources.push(source);
      return source;
    },
    onConnection: (value) => states.push(value),
    onUpdate: () => {
      reads++;
    },
  });
  sources[0].emit('ready');
  context.mock.timers.tick(100);
  await setImmediate();
  context.mock.timers.tick(19_899);
  assert.equal(states.at(-1), true);
  assert.equal(sources[0].closed, false);
  context.mock.timers.tick(1);
  assert.equal(states.at(-1), false);
  assert.equal(sources[0].closed, true);
  context.mock.timers.tick(1300);
  assert.equal(sources.length, 2);
  sources[0].emit('ready');
  sources[1].emit('ready');
  context.mock.timers.tick(100);
  await setImmediate();
  assert.equal(reads, 2);
  sources[1].onerror(new Event('error'));
  assert.equal(states.at(-1), false);
  stop();
  context.mock.timers.tick(60000);
  assert.equal(sources.length, 2);
});

test('live queries recheck periodically and use faster polling during fallback', () => {
  assert.equal(liveQueryPollInterval(true), 30_000);
  assert.equal(liveQueryPollInterval(false), 5_000);
});

test('untrusted routes and malformed frames cannot open an external stream or expose a live state', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let created = 0;
  const states = [];
  const source = new Source();
  const options = {
    createSource: () => {
      created++;
      return source;
    },
    onConnection: (value) => states.push(value),
    onUpdate: () => {
      throw new Error('No snapshot should be triggered');
    },
  };
  for (const route of [
    'https://foreign.test' + path,
    path + '?access_token=secret',
    '/internal/orders/updates',
  ])
    watchUpdates(route, options)();
  assert.equal(created, 0);
  const stop = watchUpdates(path, options);
  source.emit('ready', { accessToken: 'must-not-be-accepted' });
  assert.equal(states.at(-1), false);
  assert.equal(source.closed, true);
  stop();
});
