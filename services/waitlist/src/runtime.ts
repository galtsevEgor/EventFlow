import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { resolve } from 'node:path';
import { Coordinator } from './coordinator';
import { Database } from './database';
import type { WaitlistConfig } from './config';
import { active } from './queue';

const DISPATCH_POLL_INTERVAL_MS = 1_000;
const DISPATCH_RECONCILE_INTERVAL_MS = 30_000;
const DISPATCH_BATCH_SIZE = 100;
const WORKFLOW_SIGNAL_DEADLINE_MS = 5_000;
const TEMPORAL_CONNECT_TIMEOUT = '3 seconds';
const TEMPORAL_STATUS_DEADLINE_MS = 2_000;
const MAX_CONCURRENT_ADVANCE_ACTIVITIES = 8;
const SHUTDOWN_POLL_INTERVAL_MS = 20;

export class TemporalRuntime {
  private connection: Connection | undefined;
  private native: NativeConnection | undefined;
  private client: Client | undefined;
  private worker?: Worker;
  private running?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private busy = false;
  private stopped = false;
  private lastReconcile = 0;
  constructor(
    private readonly config: WaitlistConfig,
    private readonly db: Database,
    private readonly coordinator: Coordinator,
  ) {}
  onApplicationBootstrap() {
    this.timer = setInterval(() => void this.tick(), DISPATCH_POLL_INTERVAL_MS);
    void this.tick();
  }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      if (!this.client) {
        await this.running;
        const native = this.native,
          connection = this.connection;
        this.native = undefined;
        this.connection = undefined;
        await native?.close();
        await connection?.close();
        this.connection = await Connection.connect({
          address: this.config.TEMPORAL_ADDRESS,
          connectTimeout: TEMPORAL_CONNECT_TIMEOUT,
        });
        this.native = await NativeConnection.connect({ address: this.config.TEMPORAL_ADDRESS });
        const taskQueue = 'waitlist-' + this.config.MESSAGE_NAMESPACE;
        const client = new Client({
          connection: this.connection,
          namespace: this.config.TEMPORAL_NAMESPACE,
        });
        this.worker = await Worker.create({
          connection: this.native,
          namespace: this.config.TEMPORAL_NAMESPACE,
          taskQueue,
          ...(__filename.endsWith('.ts')
            ? { workflowsPath: resolve(__dirname, 'workflow.ts') }
            : { workflowBundle: { codePath: resolve(__dirname, 'workflow-bundle.js') } }),
          activities: { advance: (id: string) => this.coordinator.advance(id) },
          maxConcurrentActivityTaskExecutions: MAX_CONCURRENT_ADVANCE_ACTIVITIES,
        });
        this.client = client;
        this.running = this.worker.run().catch(() => {
          this.client = undefined;
        });
        // Reconcile a workflow that completed just as another subscription committed.
        await this.db.query(
          `INSERT INTO workflow_dispatch(sale_id) SELECT DISTINCT sale_id FROM waitlist_entry
          WHERE state=ANY($1::text[]) ON CONFLICT(sale_id) DO UPDATE SET revision=workflow_dispatch.revision+1`,
          active,
        );
      }
      if (Date.now() - this.lastReconcile > DISPATCH_RECONCILE_INTERVAL_MS) {
        await this.db.query(
          'UPDATE workflow_dispatch SET revision=revision+1 WHERE sale_id IN (SELECT DISTINCT sale_id FROM waitlist_entry WHERE state=ANY($1::text[]))',
          active,
        );
        this.lastReconcile = Date.now();
      }
      const rows = await this.db.query<{ sale_id: string; revision: string }>(
        'SELECT sale_id,revision::text FROM workflow_dispatch WHERE revision>delivered LIMIT $1',
        DISPATCH_BATCH_SIZE,
      );
      for (const row of rows) {
        await this.connection!.withDeadline(Date.now() + WORKFLOW_SIGNAL_DEADLINE_MS, () =>
          this.client!.workflow.signalWithStart('waitlistWorkflow', {
            taskQueue: 'waitlist-' + this.config.MESSAGE_NAMESPACE,
            workflowId: 'waitlist:' + this.config.MESSAGE_NAMESPACE + ':' + row.sale_id,
            args: [row.sale_id],
            signal: 'wake',
            signalArgs: [],
          }),
        );
        await this.db.query(
          'UPDATE workflow_dispatch SET delivered=GREATEST(delivered,$2::bigint) WHERE sale_id=$1',
          row.sale_id,
          row.revision,
        );
      }
    } catch {
      /* Durable dispatch remains pending while Temporal is unavailable. */
    } finally {
      this.busy = false;
    }
  }
  async status() {
    if (!this.connection || !this.client) throw new Error('Temporal unavailable');
    await this.connection.withDeadline(Date.now() + TEMPORAL_STATUS_DEADLINE_MS, () =>
      this.connection!.workflowService.getSystemInfo({}),
    );
  }
  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    while (this.busy)
      await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_POLL_INTERVAL_MS));
    if (this.client) this.worker?.shutdown();
    await this.running;
    await this.native?.close();
    await this.connection?.close();
  }
}
