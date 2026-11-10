import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { fullStack } from './fixture.mjs';
import { loginBuyer } from './booking-setup.mjs';

const contract = JSON.parse(readFileSync('apps/bff/openapi.json', 'utf8'));

test(
  'Swagger UI serves the BFF contract through the gateway and uses the browser session',
  { timeout: 120_000 },
  async () => {
    const stack = await fullStack();
    let browser;
    try {
      browser = await chromium.launch();
      const page = await browser.newPage();
      const externalRequests = [];
      await page.route('https://example.invalid/**', (route) => route.abort());
      const recordExternal = (request) => {
        if (new URL(request.url()).origin !== stack.origin) externalRequests.push(request.url());
      };
      page.on('request', recordExternal);
      const docsUrl = `${stack.origin}/api/v1/docs`;
      const pageResponse = await page.goto(`${docsUrl}?url=https://example.invalid/spec.json`);
      assert.equal(pageResponse.status(), 200);
      assert.match(pageResponse.headers()['content-security-policy'], /connect-src 'self'/);
      await expect(page.locator('.info .title')).toContainText(contract.info.title);

      const spec = await page.request.get(`${stack.origin}/api/v1/openapi.json`);
      assert.deepEqual(await spec.json(), contract);
      assert.equal((await page.request.get(`${docsUrl}/swagger-ui-bundle.js.map`)).status(), 404);

      async function tryOperation(method, path) {
        const operation = page.locator(`.opblock-${method.toLowerCase()}`).filter({
          has: page.locator(`[data-path="${path}"]`),
        });
        await operation.locator('.opblock-summary-control').click();
        await operation.getByRole('button', { name: 'Try it out', exact: true }).click();
        return operation;
      }

      async function execute(operation, method, path) {
        const result = page.waitForResponse(
          (response) =>
            response.request().method() === method && new URL(response.url()).pathname === path,
        );
        await operation.getByRole('button', { name: 'Execute', exact: true }).click();
        return result;
      }

      const publicPath = '/api/v1/events';
      const publicResponse = await execute(
        await tryOperation('GET', publicPath),
        'GET',
        publicPath,
      );
      assert.equal(publicResponse.status(), 200);
      assert.deepEqual(externalRequests, []);
      page.off('request', recordExternal);

      await loginBuyer(page, stack.origin);
      await page.goto(docsUrl);
      const protectedPath = '/api/v1/organizations';
      const create = await tryOperation('POST', protectedPath);
      const name = 'Swagger UI test organization';
      await create.locator('textarea').fill(JSON.stringify({ name }));
      const created = await execute(create, 'POST', protectedPath);
      assert.equal(created.status(), 201);
      assert.equal((await created.json()).name, name);
    } finally {
      await browser?.close();
      await stack.close();
    }
  },
);
