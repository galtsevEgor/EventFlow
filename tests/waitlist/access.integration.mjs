import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { waitlistFixture } from '../helpers/waitlist.mjs';
import { jsonRequest } from '../helpers/identity.mjs';
import { createApplication } from '../../packages/service-runtime/dist/index.js';
import { AppModule } from '../../services/waitlist/dist/app.module.js';
import { readWaitlistConfig } from '../../services/waitlist/dist/config.js';
test('waitlist API checks verified identity, ownership and current organizer policy', async () => {
  const f = await waitlistFixture();
  let app;
  const catalog = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/internal/policy/check') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const d = JSON.parse(Buffer.concat(chunks).toString());
      res.end(
        JSON.stringify({
          allowed:
            d.actorSubject === 'owner' &&
            d.organizationId === f.sale.organizationId &&
            d.eventId === f.sale.id,
        }),
      );
    } else res.end(JSON.stringify({ title: f.sale.title }));
  });
  await new Promise((done) => catalog.listen(0, '127.0.0.1', done));
  try {
    app = await createApplication(
      AppModule.configure(
        readWaitlistConfig({
          ...process.env,
          WAITLIST_DATABASE_URL: f.databaseUrl,
          BOOKING_URL: f.booking.origin,
          OIDC_ISSUER: f.identity.issuer,
          CATALOG_URL: 'http://127.0.0.1:' + catalog.address().port,
          EVENTFLOW_WORKLOAD: 'http',
          POLICY_CLIENT_SECRET: f.identity.serviceSecret,
        }),
      ),
      { name: 'waitlist' },
    );
    app.useLogger(false);
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    const owner = await f.identity.token('owner', { aud: 'eventflow-waitlist' }),
      outsider = await f.identity.token('outsider', { aud: 'eventflow-waitlist' });
    assert.equal((await jsonRequest(origin, '/api/v1/waitlist')).status, 401);
    const unverified = await f.identity.token('owner', {
      aud: 'eventflow-waitlist',
      email_verified: false,
    });
    assert.equal(
      (
        await jsonRequest(origin, '/api/v1/waitlist', unverified, 'POST', {
          saleId: f.sale.id,
          categoryId: 'standard',
        })
      ).status,
      403,
    );
    const joined = await jsonRequest(origin, '/api/v1/waitlist', owner, 'POST', {
      saleId: f.sale.id,
      categoryId: 'standard',
    });
    assert.equal(joined.status, 200);
    assert.equal(
      (await jsonRequest(origin, '/api/v1/waitlist/' + joined.body.id, outsider)).status,
      404,
    );
    const path =
      '/api/v1/organizations/' + f.sale.organizationId + '/events/' + f.sale.id + '/waitlist';
    assert.equal(
      (await jsonRequest(origin, path, outsider, 'PUT', { enabled: false })).status,
      403,
    );
    assert.equal((await jsonRequest(origin, path, owner, 'PUT', { enabled: false })).status, 200);
    assert.equal(
      (await jsonRequest(origin, '/api/v1/waitlist/' + joined.body.id, owner)).body.state,
      'CLOSED',
    );
  } finally {
    await app?.close();
    await new Promise((done) => catalog.close(done));
    await f.close();
  }
});
