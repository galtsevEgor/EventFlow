import { Client, Connection } from '@temporalio/client';
import { NativeConnection, Worker } from '@temporalio/worker';
import { resolve } from 'node:path';
import { Coordinator } from './coordinator';
import { Database } from './database';
import type { WaitlistConfig } from './config';
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
    this.timer = setInterval(() => void this.tick(), 1000);
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
          connectTimeout: '3 seconds',
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
          maxConcurrentActivityTaskExecutions: 8,
        });
        this.client = client;
        this.running = this.worker.run().catch(() => {
          this.client = undefined;
        });
        // Reconcile a workflow that completed just as another subscription committed.
        await this.db.query(
          `INSERT INTO workflow_dispatch(sale_id) SELECT DISTINCT sale_id FROM waitlist_entry
          WHERE state=ANY($1::text[]) ON CONFLICT(sale_id) DO UPDATE SET revision=workflow_dispatch.revision+1`,
          ['WAITING', 'RESERVING', 'OFFERED', 'CANCELLING'],
        );
      }
      if (Date.now() - this.lastReconcile > 30000) {
        await this.db.query(
          'UPDATE workflow_dispatch SET revision=revision+1 WHERE sale_id IN (SELECT DISTINCT sale_id FROM waitlist_entry WHERE state=ANY($1::text[]))',
          ['WAITING', 'RESERVING', 'OFFERED', 'CANCELLING'],
        );
        this.lastReconcile = Date.now();
      }
      const rows = await this.db.query<{ sale_id: string; revision: string }>(
        'SELECT sale_id,revision::text FROM workflow_dispatch WHERE revision>delivered LIMIT 100',
      );
      for (const row of rows) {
        await this.connection!.withDeadline(Date.now() + 5000, () =>
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
    await this.connection.withDeadline(Date.now() + 2000, () =>
      this.connection!.workflowService.getSystemInfo({}),
    );
  }
  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    while (this.busy) await new Promise((resolve) => setTimeout(resolve, 20));
    if (this.client) this.worker?.shutdown();
    await this.running;
    await this.native?.close();
    await this.connection?.close();
  }
}
