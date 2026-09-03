import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { fullStack } from './fixture.mjs';

const users = JSON.parse(readFileSync('work/local/demo-users.json', 'utf8'));
test(
  'real browser journey: shared login, organizations, drafts, invitations, roles, assignments and logout',
  { timeout: 180_000 },
  async () => {
    const stack = await fullStack();
    const browser = await chromium.launch();
    const errors = [];
    try {
      async function pageFor(alias, returnTo = '/') {
        const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
        page.setDefaultTimeout(15_000);
        page.on('pageerror', (error) => errors.push(error.message));
        const user = users.find((item) => item.username === alias);
        await page.goto(stack.origin + returnTo);
        await page.getByRole('link', { name: 'Войти', exact: true }).click();
        await page.locator('input[name="username"]').fill(user.email);
        await page.locator('input[name="password"]').fill(user.password);
        await page.locator('#kc-login').click();
        await page.waitForURL(stack.origin + returnTo);
        await expect(page.getByText(user.email, { exact: true }).first()).toBeVisible();
        return page;
      }
      const owner = await pageFor('owner');
      await owner.getByRole('link', { name: 'Организаторам' }).click();
      await expect(owner.getByRole('heading', { name: 'Организации', exact: true })).toBeVisible();
      await owner.getByRole('button', { name: 'Создать организацию', exact: true }).click();
      await expect(owner.getByLabel('Название организации', { exact: true })).toBeFocused();
      await owner.keyboard.press('Escape');
      await expect(
        owner.getByRole('button', { name: 'Создать организацию', exact: true }),
      ).toBeFocused();
      await owner.getByRole('button', { name: 'Создать организацию', exact: true }).click();
      await owner.getByRole('button', { name: 'Создать', exact: true }).click();
      await expect(owner.getByLabel('Название организации', { exact: true })).toHaveAttribute(
        'aria-invalid',
        'true',
      );
      await owner.getByLabel('Название организации', { exact: true }).fill('Вечерняя сцена');
      await owner.getByRole('button', { name: 'Создать', exact: true }).click();
      await expect(
        owner.getByRole('heading', { name: 'Вечерняя сцена', exact: true }),
      ).toBeVisible();
      const organizationId = new URL(owner.url()).searchParams.get('org');
      assert.ok(organizationId);
      await owner.getByRole('button', { name: 'Новое мероприятие', exact: true }).click();
      await owner.getByLabel('Название мероприятия').fill('Джаз в саду');
      await owner
        .getByLabel('Описание', { exact: true })
        .fill('Камерный концерт и встреча с музыкантами.');
      await owner.getByRole('button', { name: 'Сохранить черновик' }).click();
      await expect(owner.getByRole('heading', { name: 'Джаз в саду' })).toBeVisible();
      mkdirSync('work/e1', { recursive: true });
      await owner.screenshot({ path: 'work/e1/organizer-desktop.png', fullPage: true });
      await owner.setViewportSize({ width: 390, height: 844 });
      await owner.screenshot({ path: 'work/e1/organizer-mobile.png', fullPage: true });
      assert.ok(await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await owner.setViewportSize({ width: 1360, height: 1000 });

      const outsider = await pageFor('outsider', `/organizer/?org=${organizationId}`);
      const foreign = await outsider.request.get(
        `${stack.origin}/api/v1/organizations/${organizationId}`,
      );
      assert.equal(foreign.status(), 404);
      await expect(
        outsider.getByRole('heading', { name: 'Вечерняя сцена', exact: true }),
      ).toHaveCount(0);

      await owner.getByRole('button', { name: 'Команда', exact: true }).click();
      owner.on('dialog', (dialog) => dialog.accept());
      await owner.getByLabel('Роль owner@eventflow.test', { exact: true }).selectOption('MANAGER');
      await expect(owner.getByRole('alert')).toContainText('хотя бы один владелец');
      await expect(owner.getByLabel('Роль owner@eventflow.test', { exact: true })).toHaveValue(
        'OWNER',
      );

      async function invite(alias, role) {
        const previous = (await owner.getByLabel('Ссылка приглашения').count())
          ? await owner.getByLabel('Ссылка приглашения').inputValue()
          : '';
        await owner.getByLabel('Email участника').fill(`${alias}@eventflow.test`);
        await owner.getByLabel('Роль приглашения').selectOption(role);
        await owner.getByRole('button', { name: 'Создать приглашение' }).click();
        await expect(owner.getByLabel('Ссылка приглашения')).not.toHaveValue(previous);
        const link = await owner.getByLabel('Ссылка приглашения').inputValue();
        const member = await pageFor(alias, new URL(link).pathname + new URL(link).search);
        await member.getByRole('button', { name: 'Принять приглашение' }).click();
        await expect(
          member.getByRole('heading', { name: 'Вечерняя сцена', exact: true }),
        ).toBeVisible();
        await owner.reload();
        await owner.getByRole('button', { name: 'Команда', exact: true }).click();
        return member;
      }
      const manager = await invite('manager', 'MANAGER');
      await expect(manager.getByRole('button', { name: 'Команда', exact: true })).toHaveCount(0);
      await expect(manager.getByRole('heading', { name: 'Джаз в саду' })).toBeVisible();
      await manager.getByRole('button', { name: 'Редактировать', exact: true }).click();
      await manager.getByLabel('Описание', { exact: true }).fill('Описание обновлено менеджером.');
      await manager.getByRole('button', { name: 'Сохранить черновик' }).click();
      await expect(
        manager.getByText('Описание обновлено менеджером.', { exact: true }),
      ).toBeVisible();

      const staff = await invite('staff', 'STAFF');
      await expect(
        staff.getByRole('button', { name: 'Новое мероприятие', exact: true }),
      ).toHaveCount(0);
      await expect(staff.getByRole('heading', { name: 'Джаз в саду' })).toHaveCount(0);
      const assignmentResponse = owner.waitForResponse(
        (response) => response.request().method() === 'PUT' && response.url().includes('/members/'),
      );
      await owner
        .getByRole('article', { name: 'staff@eventflow.test', exact: true })
        .getByLabel('Джаз в саду')
        .click();
      assert.equal((await assignmentResponse).status(), 200);
      await expect(
        owner
          .getByRole('article', { name: 'staff@eventflow.test', exact: true })
          .getByLabel('Джаз в саду'),
      ).toBeChecked();
      await expect(
        owner
          .getByRole('article', { name: 'staff@eventflow.test', exact: true })
          .getByLabel('Джаз в саду'),
      ).toBeEnabled();
      await staff.reload();
      await expect(staff.getByRole('heading', { name: 'Джаз в саду' })).toBeVisible();

      // Leave a write form open while an owner revokes the editor's role.
      await manager.getByRole('button', { name: 'Новое мероприятие', exact: true }).click();
      await manager.getByLabel('Название мероприятия').fill('Запрещённый черновик');
      await owner.getByLabel('Роль manager@eventflow.test', { exact: true }).selectOption('STAFF');
      await expect(owner.getByLabel('Роль manager@eventflow.test', { exact: true })).toBeEnabled();
      await manager.getByRole('button', { name: 'Сохранить черновик' }).click();
      await expect(manager.getByRole('alert')).toContainText('Недостаточно прав');
      await manager.keyboard.press('Escape');
      await manager.reload();
      await expect(
        manager.getByRole('button', { name: 'Новое мероприятие', exact: true }),
      ).toHaveCount(0);

      const storage = await owner.context().storageState();
      assert.equal(storage.origins.flatMap((item) => item.localStorage).length, 0);
      assert.equal(await owner.evaluate(() => sessionStorage.length), 0);
      assert.equal(
        await owner.evaluate(() => document.cookie.includes('eventflow_session')),
        false,
      );
      assert.doesNotMatch(
        await owner.content(),
        /access_token|refresh_token|id_token|eyJ[\w-]+\.[\w-]+\.[\w-]+/,
      );
      const cookie = (await owner.context().cookies()).find(
        (item) => item.name === 'eventflow_session',
      );
      await owner.getByRole('button', { name: 'Выйти', exact: true }).click();
      await owner.waitForURL((url) => url.pathname.includes('/logout'));
      assert.ok(!owner.url().includes('id_token_hint'));
      await owner.locator('#kc-logout').click();
      await owner.waitForURL(stack.origin + '/');
      await expect(owner.getByRole('link', { name: 'Войти', exact: true })).toBeVisible();
      const replay = await owner.request.get(stack.origin + '/api/v1/auth/session', {
        headers: { cookie: `${cookie.name}=${cookie.value}` },
      });
      assert.deepEqual(await replay.json(), { user: null });
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
      await stack.close();
    }
  },
);
