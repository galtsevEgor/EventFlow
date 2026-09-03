import assert from 'node:assert/strict';
import test from 'node:test';
import { accessLog } from '../dist/index.js';

test('access logs retain correlation while excluding tokens, email and request payloads', () => {
  const request = {
    method: 'POST',
    originalUrl: '/callback?code=private-code',
    headers: { authorization: 'Bearer private-token', cookie: 'private-session' },
    body: { email: 'private-email', password: 'private-password' },
  };
  const log = accessLog(
    request,
    {
      statusCode: 403,
      locals: {
        requestId: 'request-id',
        traceparent: '00-12345678901234567890123456789012-1234567890123456-01',
      },
    },
    2.5,
  );
  assert.equal(log.traceId, '12345678901234567890123456789012');
  assert.equal(log.requestId, 'request-id');
  assert.ok(!JSON.stringify(log).includes('private'));
  assert.deepEqual(Object.keys(log).sort(), [
    'durationMs',
    'kind',
    'method',
    'requestId',
    'status',
    'traceId',
  ]);
});
