import assert from 'node:assert/strict';
import test from 'node:test';
import { Subject, lastValueFrom, of, throwError } from 'rxjs';
import { HttpAdmission } from '../dist/http-admission.js';
import { Controller, Get, Module } from '@nestjs/common';
import { createApplication, HealthModule } from '../dist/index.js';

const context = (path = '/api/v1/events') => ({
  switchToHttp: () => ({ getRequest: () => ({ path }) }),
});
test('busy handlers reject excess work, keep health available and release capacity on completion', async () => {
  const admission = new HttpAdmission(1),
    pending = new Subject();
  const work = lastValueFrom(admission.intercept(context(), { handle: () => pending }));
  assert.throws(
    () => admission.intercept(context(), { handle: () => of('extra') }),
    (error) => error.getStatus() === 503,
  );
  assert.equal(
    await lastValueFrom(
      admission.intercept(context('/health/ready'), { handle: () => of('ready') }),
    ),
    'ready',
  );
  pending.next('done');
  pending.complete();
  assert.equal(await work, 'done');
  assert.equal(
    await lastValueFrom(admission.intercept(context(), { handle: () => of('next') })),
    'next',
  );
});
test('failed and synchronously throwing handlers release capacity without disabling limits', async () => {
  const admission = new HttpAdmission(1);
  await assert.rejects(
    lastValueFrom(
      admission.intercept(context(), {
        handle: () => throwError(() => new Error('async failure')),
      }),
    ),
    /async failure/,
  );
  await assert.rejects(
    lastValueFrom(
      admission.intercept(context(), {
        handle: () => {
          throw new Error('sync failure');
        },
      }),
    ),
    /sync failure/,
  );
  assert.equal(
    await lastValueFrom(admission.intercept(context(), { handle: () => of('recovered') })),
    'recovered',
  );
  assert.throws(() => new HttpAdmission(0), /Invalid HTTP/);
});

test('real HTTP admission preserves running work after disconnect and keeps health reachable', async () => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers(),
    finished = Promise.withResolvers();
  class WorkController {
    async run() {
      entered.resolve();
      await release.promise;
      finished.resolve();
      return { ok: true };
    }
  }
  Controller('work')(WorkController);
  Get()(
    WorkController.prototype,
    'run',
    Object.getOwnPropertyDescriptor(WorkController.prototype, 'run'),
  );
  class TestModule {}
  Module({ imports: [HealthModule.forService('admission-test')], controllers: [WorkController] })(
    TestModule,
  );
  const app = await createApplication(TestModule, { httpConcurrency: 1 });
  app.useLogger(false);
  const controller = new AbortController();
  let first;
  try {
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    first = fetch(origin + '/work', { signal: controller.signal }).catch((error) => error);
    await entered.promise;
    controller.abort();
    await first;
    const busy = await fetch(origin + '/work');
    assert.equal(busy.status, 503);
    assert.equal(busy.headers.get('retry-after'), '5');
    assert.equal((await busy.json()).retryable, true);
    assert.equal((await fetch(origin + '/health/ready')).status, 200);
    release.resolve();
    await finished.promise;
    assert.equal((await fetch(origin + '/work')).status, 200);
  } finally {
    release.resolve();
    controller.abort();
    await first;
    await app.close();
  }
});
