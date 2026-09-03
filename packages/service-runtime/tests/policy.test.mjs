import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { requirePolicy } from '../dist/index.js';

test('policy transport never permits an action on failure, malformed response or denied permission', async () => {
  let status = 200,
    body = { allowed: false };
  const server = createServer((_request, response) => {
    response.statusCode = status;
    response.setHeader('connection', 'close');
    response.end(JSON.stringify(body));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}`;
  const query = { actorSubject: 'staff', organizationId: 'test', action: 'check-in' };
  try {
    await assert.rejects(
      requirePolicy(url, 'synthetic', query),
      (error) => error.getStatus() === 403,
    );
    for (const response of [
      { status: 500, body: {} },
      { status: 200, body: { allowed: 'yes' } },
      { status: 200, body: {} },
    ]) {
      status = response.status;
      body = response.body;
      await assert.rejects(
        requirePolicy(url, 'synthetic', query),
        (error) => error.getStatus() === 503,
      );
    }
  } finally {
    await new Promise((done) => server.close(done));
  }
  await assert.rejects(
    requirePolicy(url, 'synthetic', query),
    (error) => error.getStatus() === 503,
  );
});
