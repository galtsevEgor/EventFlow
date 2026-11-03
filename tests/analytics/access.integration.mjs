import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeJwt } from 'jose';
import { analyticsFixture, fact } from '../helpers/analytics.mjs';
import { catalogFixture } from '../../services/catalog/tests/fixture.mjs';
import { AppModule } from '../../services/analytics/dist/app.module.js';
import { readAnalyticsConfig } from '../../services/analytics/dist/config.js';
import { AnalyticsProjection } from '../../services/analytics/dist/projection.js';
import { AnalyticsReport } from '../../services/analytics/dist/report.js';
import { createApplication, ClientCredentials } from '../../packages/service-runtime/dist/index.js';
test('HTTP reports recheck current roles, isolate tenants and never accept browser confirmations', async () => {
  const f = await analyticsFixture(),
    catalog = await catalogFixture();
  let app;
  try {
    const owner = await catalog.token();
    const org = await catalog.request('/api/v1/organizations', owner, 'POST', {
      name: 'Analytics test',
    });
    assert.equal(org.status, 201);
    const organizationId = org.body.id;
    const config = readAnalyticsConfig({
      ...f.env,
      EVENTFLOW_WORKLOAD: 'http',
      OIDC_ISSUER: decodeJwt(owner).iss,
      CATALOG_URL: catalog.origin,
    });
    const module = AppModule.configure(config);
    module.providers = module.providers.map((provider) =>
      typeof provider === 'object' && provider.provide === ClientCredentials
        ? {
            provide: ClientCredentials,
            useValue: {
              token: () =>
                catalog.token({
                  azp: 'eventflow-policy',
                  realm_access: { roles: ['policy-check'] },
                }),
            },
          }
        : provider,
    );
    app = await createApplication(module, { name: 'analytics' });
    app.useLogger(false);
    await app.listen(0, '127.0.0.1');
    await app.get(AnalyticsProjection).sync();
    const reports = app.get(AnalyticsReport),
      read = reports.read.bind(reports);
    let failureType;
    reports.read = async (...args) => {
      try {
        return await read(...args);
      } catch (error) {
        failureType = error instanceof Error ? error.name : 'Unknown';
        throw error;
      }
    };
    const origin = await app.getUrl(),
      user = await catalog.token({ aud: 'eventflow-analytics' });
    const report =
      '/api/v1/organizations/' + organizationId + '/analytics?from=2026-11-09&to=2026-11-09';
    const get = async (path, token = user) =>
      fetch(origin + path, { headers: { authorization: 'Bearer ' + token } });
    const response = await get(report);
    assert.equal(
      response.status,
      200,
      JSON.stringify({ body: await response.json(), failureType }),
    );
    const stranger = await catalog.token({ sub: 'stranger', aud: 'eventflow-analytics' });
    assert.equal((await get(report, stranger)).status, 403);
    await catalog.db.membership.update({
      where: { organizationId_userSubject: { organizationId, userSubject: 'test-owner' } },
      data: { role: 'STAFF' },
    });
    assert.equal((await get(report)).status, 403);
    assert.equal(
      (await get('/api/v1/analytics/search-quality?from=2026-11-09&to=2026-11-09')).status,
      403,
    );
    const operator = await catalog.token({
      aud: 'eventflow-analytics',
      realm_access: { roles: ['ops-view'] },
    });
    assert.equal(
      (await get('/api/v1/analytics/search-quality?from=2026-11-09&to=2026-11-09', operator))
        .status,
      200,
    );
    const ingest = await catalog.token({
      azp: 'eventflow-analytics',
      aud: 'eventflow-analytics',
      realm_access: { roles: ['analytics-ingest'] },
    });
    assert.equal(
      (
        await fetch(origin + '/internal/analytics/search', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + ingest, 'content-type': 'application/json' },
          body: JSON.stringify(fact({ kind: 'confirmed' })),
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await fetch(origin + '/internal/analytics/events', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + user, 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await get(
          '/api/v1/organizations/' + organizationId + '/analytics?from=2026-01-01&to=2026-12-31',
        )
      ).status,
      422,
    );
  } finally {
    await app?.close();
    await catalog.close();
    await f.close();
  }
});
