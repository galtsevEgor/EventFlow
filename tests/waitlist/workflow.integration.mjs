import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
const require = createRequire(new URL('../../services/waitlist/package.json', import.meta.url));
const { Worker, Runtime } = require('@temporalio/worker');
const { TestWorkflowEnvironment } = require('@temporalio/testing');
const { Connection, Client } = require('@temporalio/client');
const { NativeConnection } = require('@temporalio/worker');
Runtime.install({ logger: { log() {}, trace() {}, debug() {}, info() {}, warn() {}, error() {} } });
const workflowsPath = resolve('services/waitlist/dist/workflow.js');
test(
  'Temporal retries activities and advances durable timers without waiting in real time',
  { timeout: 60000 },
  async () => {
    const env = await TestWorkflowEnvironment.createTimeSkipping();
    let attempts = 0;
    const worker = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace,
      taskQueue: randomUUID(),
      workflowsPath,
      bundlerOptions: {
        webpackConfigHook: (config) => ({
          ...config,
          infrastructureLogging: { level: 'error' },
          stats: 'errors-only',
        }),
      },
      activities: {
        async advance() {
          attempts++;
          if (attempts === 1) throw new Error('Temporary Booking failure');
          return { stopped: attempts === 3, wakeAfterMs: 30000 };
        },
      },
    });
    try {
      await worker.runUntil(() =>
        env.client.workflow.execute('waitlistWorkflow', {
          taskQueue: worker.options.taskQueue,
          workflowId: randomUUID(),
          args: [randomUUID()],
        }),
      );
      assert.equal(attempts, 3);
    } finally {
      await env.teardown();
    }
  },
);
test(
  'Temporal resumes a pending timer after worker restart and accepts a wake signal',
  { timeout: 60000 },
  async () => {
    const connection = await Connection.connect({
      address: process.env.TEMPORAL_ADDRESS || '127.0.0.1:17233',
    });
    const native = await NativeConnection.connect({
      address: process.env.TEMPORAL_ADDRESS || '127.0.0.1:17233',
    });
    const client = new Client({ connection, namespace: 'eventflow' });
    const taskQueue = randomUUID(),
      saleId = randomUUID();
    let calls = 0,
      done = false;
    const options = {
      connection: native,
      namespace: 'eventflow',
      taskQueue,
      workflowsPath,
      activities: {
        async advance(id) {
          assert.equal(id, saleId);
          calls++;
          return { stopped: done, wakeAfterMs: 30000 };
        },
      },
    };
    let worker = await Worker.create(options);
    let running = worker.run();
    try {
      const handle = await client.workflow.start('waitlistWorkflow', {
        taskQueue,
        workflowId: randomUUID(),
        args: [saleId],
      });
      for (let i = 0; calls < 1 && i < 200; i++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(calls, 1);
      for (let i = 0; i < 200; i++) {
        if ((await handle.fetchHistory()).events.some((e) => e.timerStartedEventAttributes)) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      worker.shutdown();
      await running;
      worker = await Worker.create(options);
      running = worker.run();
      done = true;
      await handle.signal('wake');
      await handle.result();
      assert.equal(calls, 2);
    } finally {
      worker.shutdown();
      await running;
      await connection.close();
      await native.close();
    }
  },
);
