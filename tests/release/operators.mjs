import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';
import { active, composeOutput, environment } from '../../scripts/release/local.mjs';
import { loginBuyer } from '../e2e/booking-setup.mjs';

if (process.argv.slice(2).join(' ') !== 'staging')
  throw new Error(
    'Use test:release-operators staging; this creates an owned synthetic mail incident.',
  );
const target = environment('staging'),
  deployment = active(target);
if (!deployment) throw new Error('Deploy staging before operator acceptance.');
const users = 'work/release/staging/work/local/demo-users.json';
function sql(statement) {
  return composeOutput(
    target,
    [
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'catalog',
      '-d',
      'catalog',
      '-v',
      'ON_ERROR_STOP=1',
      '-At',
      '-c',
      statement,
    ],
    { image: deployment.image },
  );
}
const browser = await chromium.launch();
try {
  const owner = await browser.newPage();
  const headers = await loginBuyer(owner, target.origin, 'owner', users);
  const organization = await owner.request.post(target.origin + '/api/v1/organizations', {
    headers,
    data: { name: `Operator acceptance ${randomUUID()}` },
  });
  assert.equal(organization.status(), 201);
  const { id: organizationId } = await organization.json();
  const invited = await owner.request.post(
    `${target.origin}/api/v1/organizations/${organizationId}/invitations`,
    {
      headers,
      data: { email: `acceptance-${randomUUID()}@eventflow.test`, role: 'STAFF' },
    },
  );
  assert.equal(invited.status(), 201);
  const { id } = await invited.json();
  assert.match(id, /^[a-f0-9-]{36}$/);
  await expect
    .poll(() => sql(`SELECT state FROM "DeliveryJob" WHERE id='${id}'::uuid`), { timeout: 30000 })
    .toBe('SENT');
  // Inject only the incident created above. No existing job or financial record is modified.
  assert.equal(
    sql(
      `UPDATE "DeliveryJob" SET state='DEAD', attempts=4 WHERE id='${id}'::uuid AND state='SENT' AND lease IS NULL RETURNING id`,
    ).split(/\r?\n/)[0],
    id,
  );
  const path = `/organizer/ops?source=catalog&kind=mail&id=${id}`;
  const viewer = await browser.newPage();
  await loginBuyer(viewer, target.origin, 'ops-viewer', users);
  await viewer.goto(target.origin + path);
  await expect(viewer.getByText('Только просмотр', { exact: true })).toBeVisible();
  await expect(viewer.getByRole('button', { name: 'Запустить восстановление' })).toHaveCount(0);
  const operator = await browser.newPage();
  await loginBuyer(operator, target.origin, 'operator', users);
  const session = await (await operator.request.get(target.origin + '/api/v1/auth/session')).json();
  await operator.goto(target.origin + path);
  await operator.getByRole('button', { name: 'Запустить восстановление' }).click();
  const dialog = operator.getByRole('dialog');
  await dialog
    .getByLabel('Причина восстановления')
    .fill('Локальная проверка восстановления доставки после сбоя');
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Подтвердить запуск' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(operator.getByText('Письмо отправлено', { exact: true })).toBeVisible({
    timeout: 30000,
  });
  assert.equal(sql(`SELECT count(*) FROM "DeliveryJob" WHERE id='${id}'::uuid`), '1');
  assert.equal(
    sql(`SELECT count(*) FROM "DeliveryRetry" WHERE "jobId"='${id}'::uuid AND "actorType"='HUMAN'`),
    '1',
  );
  const detail = await (
    await operator.request.get(`${target.origin}/api/v1/ops/issues/catalog/mail/${id}`)
  ).json();
  assert.equal(detail.actions[0].actor, session.user.sub);
  assert.equal(detail.actions[0].actorType, 'HUMAN');
  assert.equal(detail.issue.state, 'SENT');
  assert.equal(detail.recoverable, false);
  writeFileSync(
    'work/release/operator-acceptance.json',
    JSON.stringify(
      {
        release: deployment.id,
        image: deployment.image,
        organizationId,
        jobId: id,
        action: detail.actions[0].key,
        state: detail.issue.state,
        checkedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
  console.log('Staging operator roles, human audit and same-job mail recovery verified.');
} finally {
  await browser.close();
}
