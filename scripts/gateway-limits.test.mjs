import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createAdmission } from './gateway-limits.mjs';

function pair(address = '127.0.0.1') {
  const request = {
    socket: { remoteAddress: address },
    headers: { 'x-forwarded-for': Math.random().toString() },
    resume() {},
  };
  const response = new EventEmitter();
  response.writeHead = (status, headers) => {
    response.status = status;
    response.headers = headers;
  };
  response.end = (body) => {
    response.body = JSON.parse(body);
    response.emit('finish');
  };
  return [request, response];
}
test('rate windows isolate API and SSR, ignore forwarded identities and bound client storage', () => {
  let time = 0;
  const admit = createAdmission(
    { apiRequests: 1, ssrRequests: 1, maxClients: 1, windowMs: 1000 },
    () => time,
  );
  let [req, res] = pair();
  assert.equal(admit(req, res, 'api'), true);
  res.emit('finish');
  [req, res] = pair();
  assert.equal(admit(req, res, 'api'), false);
  assert.equal(res.status, 429);
  assert.equal(res.headers['retry-after'], '1');
  assert.equal(res.body.retryable, true);
  [req, res] = pair();
  assert.equal(admit(req, res, 'ssr'), true);
  res.emit('finish');
  [req, res] = pair('127.0.0.2');
  assert.equal(admit(req, res, 'api'), false);
  time = 1000;
  [req, res] = pair('127.0.0.2');
  assert.equal(admit(req, res, 'api'), true);
  res.emit('finish');
});
test('concurrency is released exactly once and webhooks retain their own budget', () => {
  const admit = createAdmission({ apiConcurrent: 1 });
  const [req, res] = pair();
  assert.equal(admit(req, res, 'api'), true);
  const [busyReq, busyRes] = pair();
  assert.equal(admit(busyReq, busyRes, 'api'), false);
  assert.equal(busyRes.status, 503);
  assert.equal(busyRes.body.code, 'HTTP_BUSY');
  const [hookReq, hookRes] = pair();
  assert.equal(admit(hookReq, hookRes, 'webhook'), true);
  hookRes.emit('finish');
  res.emit('finish');
  res.emit('close');
  const [nextReq, nextRes] = pair();
  assert.equal(admit(nextReq, nextRes, 'api'), true);
  const [extraReq, extraRes] = pair();
  assert.equal(admit(extraReq, extraRes, 'api'), false);
  nextRes.emit('close');
  assert.throws(() => createAdmission({ apiRequests: 0 }), /Invalid gateway/);
});
