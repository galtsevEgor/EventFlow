import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { createApiClient, unwrap } from '../dist/index.js';

test('private recommendation responses stay bound to the account that issued the request', async () => {
  const requests = [];
  let actor = 'buyer-a';
  const server = createServer((req, res) => {
    requests.push(req.headers['x-eventflow-actor']);
    res.setHeader('content-type', 'application/json');
    res.setHeader('x-eventflow-actor', actor);
    res.end(JSON.stringify({ revision: 0, interests: [], favorites: [] }));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    const api = createApiClient('http://127.0.0.1:' + server.address().port);
    api.setActor('buyer-a');
    assert.equal(unwrap(await api.client.GET('/api/v1/recommendations/profile')).revision, 0);
    actor = 'buyer-b';
    await assert.rejects(api.client.GET('/api/v1/recommendations/profile'), /Аккаунт изменился/);
    api.setActor('buyer-b');
    assert.equal(unwrap(await api.client.GET('/api/v1/recommendations/profile')).revision, 0);
    await api.client.GET('/api/v1/recommendations/interests');
    assert.deepEqual(requests, ['buyer-a', 'buyer-a', 'buyer-b', undefined]);
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
});
