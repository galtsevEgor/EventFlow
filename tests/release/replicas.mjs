import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { kubeOutput, kubectl } from '../../scripts/cluster/local.mjs';

const origin = 'http://127.0.0.1:58000';
const evidence = 'work/e7/retained-asset.json';
const [command, release] = process.argv.slice(2);
const digest = (buffer) => createHash('sha256').update(buffer).digest('hex');

async function asset() {
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  const path = (await page.text()).match(
    /\/_next\/static\/[^"\s<>]+?\.(?:js|css)(?:\?dpl=[a-f0-9]+)?/,
  )?.[0];
  assert.ok(path, 'Storefront did not reference a static asset');
  return new URL(path, origin);
}

function pods(service) {
  const data = JSON.parse(
    kubeOutput([
      'get',
      'pods',
      '-l',
      `app.kubernetes.io/name=${service},app.kubernetes.io/component=http`,
      '-o',
      'json',
    ]),
  );
  const ready = data.items.filter(
    (pod) =>
      !pod.metadata.deletionTimestamp &&
      pod.status.conditions.some(({ type, status }) => type === 'Ready' && status === 'True'),
  );
  assert.equal(ready.length, 3, `Expected three ready ${service} replicas`);
  return ready.map((pod) => pod.status.podIP);
}

async function verifySessions() {
  const [owner] = JSON.parse(readFileSync('work/e7/credentials/demo-users.json', 'utf8'));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(origin + '/api/v1/auth/login?returnTo=%2Forders');
    await page.locator('input[name=username]').fill(owner.email);
    await page.locator('input[name=password]').fill(owner.password);
    await page.locator('#kc-login').click();
    await page.waitForURL(origin + '/orders');
    const cookie = (await page.context().cookies(origin))
      .map(({ name, value }) => name + '=' + value)
      .join('; ');
    assert.ok(cookie);
    const probe = `
      const { storefront, bff, cookie, email } = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
      async function verify() {
        for (const ip of storefront) {
          const response = await fetch('http://' + ip + ':3000/');
          if (!response.ok || !(await response.text()).includes('/_next/static/'))
            throw new Error('Storefront replica did not render');
        }
        for (const ip of bff) {
          const response = await fetch('http://' + ip + ':4000/api/v1/auth/session', {headers: {cookie}});
          if (!response.ok || (await response.json()).user?.email !== email)
            throw new Error('BFF replica could not read the session');
        }
      }
      verify().catch((error) => { console.error(error.message); process.exitCode = 1; });
    `;
    kubectl(['exec', '-i', 'deployment/gateway', '--', 'node', '-e', probe], {
      input: JSON.stringify({
        storefront: pods('storefront'),
        bff: pods('bff'),
        cookie,
        email: owner.email,
      }),
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    pods('booking');
  } finally {
    await browser.close();
  }
}

assert.match(release ?? '', /^[a-f0-9]{40}$/);
if (command === 'snapshot') {
  const url = await asset();
  const response = await fetch(url);
  assert.equal(response.status, 200);
  writeFileSync(
    evidence,
    JSON.stringify({
      path: url.pathname,
      release,
      sha256: digest(Buffer.from(await response.arrayBuffer())),
    }),
  );
} else if (command === 'verify') {
  const previous = JSON.parse(readFileSync(evidence, 'utf8'));
  assert.notEqual(previous.release, release);
  const active = await asset();
  assert.equal(active.searchParams.get('dpl'), release);
  const url = new URL(previous.path, origin);
  url.searchParams.set('dpl', previous.release);
  const retained = await fetch(url);
  assert.equal(retained.status, 200);
  assert.equal(retained.headers.get('x-eventflow-asset-deployment'), previous.release);
  assert.equal(digest(Buffer.from(await retained.arrayBuffer())), previous.sha256);
  await verifySessions();
  console.log('Retained asset bytes, SSR and shared BFF session verified across replicas');
} else throw new Error('Use snapshot RELEASE_ID or verify RELEASE_ID.');
