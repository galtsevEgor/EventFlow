import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import test from 'node:test';
import { chromium, expect } from '@playwright/test';
import { fullStack } from './fixture.mjs';
import { loginBuyer } from './booking-setup.mjs';

const content = (locator) =>
  locator.evaluate((element) => {
    const copy = element.cloneNode(true);
    copy
      .querySelectorAll('.cm-ySelectionCaret, .cm-ySelectionInfo')
      .forEach((node) => node.remove());
    return copy.textContent;
  });
const text = async (locator, expected) => {
  try {
    await expect.poll(() => content(locator), { timeout: 15000 }).toBe(expected);
  } catch (error) {
    throw new Error(
      error.message +
        '\nEditor: ' +
        (await locator.locator('xpath=ancestor::section[1]').innerText()),
      { cause: error },
    );
  }
};
test(
  'collaborative editor merges real users, preserves offline edits and lost acknowledgements, and enforces read-only roles',
  { timeout: 240000 },
  async () => {
    const stack = await fullStack();
    const browser = await chromium.launch();
    try {
      const owner = await browser.newPage({ viewport: { width: 1360, height: 1050 } }),
        manager = await browser.newPage(),
        staff = await browser.newPage();
      const errors = [];
      for (const page of [owner, manager, staff]) {
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('dialog', (dialog) => dialog.accept());
      }
      const ownerHeaders = await loginBuyer(owner, stack.origin);
      const managerHeaders = await loginBuyer(manager, stack.origin, 'manager');
      const staffHeaders = await loginBuyer(staff, stack.origin, 'staff');
      const orgResponse = await owner.request.post(stack.origin + '/api/v1/organizations', {
        headers: ownerHeaders,
        data: { name: 'Совместная сцена' },
      });
      assert.equal(orgResponse.status(), 201);
      const org = await orgResponse.json(),
        path = stack.origin + '/api/v1/organizations/' + org.id;
      const draft = await (
        await owner.request.post(path + '/events', {
          headers: ownerHeaders,
          data: { title: 'Общий концерт', description: 'Концерт' },
        })
      ).json();
      for (const [page, alias, role, headers] of [
        [manager, 'manager', 'MANAGER', managerHeaders],
        [staff, 'staff', 'STAFF', staffHeaders],
      ]) {
        const invitation = await owner.request.post(path + '/invitations', {
          headers: ownerHeaders,
          data: { email: alias + '@eventflow.test', role },
        });
        assert.equal(invitation.status(), 201);
        const accepted = await page.request.post(stack.origin + '/api/v1/invitations/accept', {
          headers,
          data: { token: (await invitation.json()).token },
        });
        assert.equal(accepted.status(), 200);
      }
      const staffSession = await (
        await staff.request.get(stack.origin + '/api/v1/auth/session')
      ).json();
      assert.equal(
        (
          await owner.request.put(
            path + '/members/' + staffSession.user.sub + '/events/' + draft.id,
            {
              headers: ownerHeaders,
              data: { assigned: true },
            },
          )
        ).status(),
        200,
      );

      let partition = false,
        dropAcknowledgements = false,
        active;
      const sent = [];
      await manager.routeWebSocket('**/collaboration/socket', (socket) => {
        if (partition) {
          void socket.close({ code: 1013 });
          return;
        }
        const server = socket.connectToServer();
        active = { socket, server };
        socket.onMessage((message) => {
          const frame = JSON.parse(message.toString());
          if (frame.type === 'update') sent.push(frame);
          server.send(message);
        });
        server.onMessage((message) => {
          if (dropAcknowledgements && JSON.parse(message.toString()).type === 'ack') return;
          socket.send(message);
        });
      });
      async function open(page) {
        await page.goto(stack.origin + '/organizer/?org=' + org.id);
        await page.getByRole('button', { name: 'Совместный редактор', exact: true }).click();
        await expect(page.getByRole('textbox', { name: 'Совместное описание' })).toBeVisible();
        await expect(page.getByText('Сохранено на сервере', { exact: true })).toBeVisible({
          timeout: 15000,
        });
      }
      await open(owner);
      await open(manager);
      await open(staff);
      const a = owner.getByRole('textbox', { name: 'Совместное описание' }),
        b = manager.getByRole('textbox', { name: 'Совместное описание' }),
        readonly = staff.getByRole('textbox', { name: 'Совместное описание' });
      await expect(staff.getByText(/Только чтение/)).toBeVisible();
      await readonly.click();
      await staff.keyboard.type('forbidden');
      await text(readonly, 'Концерт');
      await Promise.all([
        (async () => {
          await a.click();
          await owner.keyboard.press('Control+Home');
          await owner.keyboard.insertText('Живой ');
        })(),
        (async () => {
          await b.click();
          await manager.keyboard.press('Control+End');
          await manager.keyboard.insertText(' вечером');
        })(),
      ]);
      await text(a, 'Живой Концерт вечером');
      await text(b, 'Живой Концерт вечером');
      await b.click();
      await manager.keyboard.press('Control+End');
      await expect(owner.locator('.cm-ySelectionCaret')).toHaveCount(1, { timeout: 10000 });
      await manager.keyboard.press('Control+z');
      await text(a, 'Живой Концерт');
      await manager.keyboard.press('Control+y');
      await text(a, 'Живой Концерт вечером');
      await expect(manager.getByText('Сохранено на сервере', { exact: true })).toBeVisible();

      // Delete-only updates leave a Yjs state vector unchanged. A server snapshot must not acknowledge them.
      dropAcknowledgements = true;
      const editIndex = sent.length;
      await b.click();
      await manager.keyboard.press('Control+Home');
      await manager.keyboard.press('Delete');
      await text(a, 'ивой Концерт вечером');
      await expect(manager.getByText('Сохранение…', { exact: true })).toBeVisible();
      const pending = await manager.evaluate(() => {
        const key = Object.keys(sessionStorage).find((key) => key.startsWith('eventflow:draft:'));
        return JSON.parse(sessionStorage.getItem(key)).inflight;
      });
      assert.ok(pending?.id);
      dropAcknowledgements = false;
      await manager.reload();
      await manager.getByRole('button', { name: 'Совместный редактор', exact: true }).click();
      await expect(manager.getByText('Сохранено на сервере', { exact: true })).toBeVisible({
        timeout: 15000,
      });
      assert.ok(sent.slice(editIndex).filter((frame) => frame.id === pending.id).length >= 2);
      assert.ok(
        sent
          .slice(editIndex)
          .filter((frame) => frame.id === pending.id)
          .every((frame) => frame.state === pending.state),
      );
      await text(b, 'ивой Концерт вечером');

      partition = true;
      await active.socket.close({ code: 1013 });
      await active.server.close({ code: 1013 });
      await expect(manager.getByText(/Нет связи/)).toBeVisible();
      await b.click();
      await manager.keyboard.press('Control+End');
      await manager.keyboard.insertText(' + офлайн');
      await expect.poll(() => content(b)).toContain('+ офлайн');
      await a.click();
      await owner.keyboard.press('Control+Home');
      await owner.keyboard.insertText('Новый ');
      await expect(owner.getByText('Сохранено на сервере', { exact: true })).toBeVisible();
      await manager.keyboard.press('Escape');
      await expect(
        manager.getByRole('button', { name: 'Опубликовать', exact: true }),
      ).toBeDisabled();
      await manager.reload();
      await manager.getByRole('button', { name: 'Совместный редактор', exact: true }).click();
      await expect.poll(() => content(b)).toContain('+ офлайн');
      partition = false;
      await expect(manager.getByText('Сохранено на сервере', { exact: true })).toBeVisible({
        timeout: 20000,
      });
      await text(a, 'Новый ивой Концерт вечером + офлайн');
      await text(b, 'Новый ивой Концерт вечером + офлайн');

      const managerSession = await (
        await manager.request.get(stack.origin + '/api/v1/auth/session')
      ).json();
      assert.equal(
        (
          await owner.request.patch(path + '/members/' + managerSession.user.sub, {
            headers: ownerHeaders,
            data: { role: 'STAFF' },
          })
        ).status(),
        200,
      );
      await expect(manager.getByText('Синхронизация остановлена', { exact: true })).toBeVisible({
        timeout: 10000,
      });
      await b.click();
      await manager.keyboard.insertText('forbidden');
      await expect.poll(() => content(b)).not.toContain('forbidden');
      assert.equal((await owner.request.get(path + '/events/' + draft.id)).status(), 200);
      assert.equal(errors.length, 0, errors.join('\n'));
      mkdirSync('work/e16/screenshots', { recursive: true });
      await owner.screenshot({ path: 'work/e16/screenshots/editor-desktop.png', fullPage: true });
      await owner.setViewportSize({ width: 390, height: 844 });
      await owner.screenshot({ path: 'work/e16/screenshots/editor-mobile.png', fullPage: true });
      assert.equal(
        await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await manager.keyboard.press('Escape');
      assert.ok(
        await manager.evaluate(() =>
          Object.keys(sessionStorage).some((key) => key.startsWith('eventflow:draft:')),
        ),
      );
      await manager.getByRole('button', { name: 'Выйти', exact: true }).click();
      await manager.waitForURL((url) => url.pathname.includes('/logout'));
      await manager.locator('#kc-logout').click();
      await manager.waitForURL(stack.origin + '/');
      assert.equal(
        await manager.evaluate(() =>
          Object.keys(sessionStorage).some((key) => key.startsWith('eventflow:draft:')),
        ),
        false,
      );
    } finally {
      await browser.close();
      await stack.close();
    }
  },
);
