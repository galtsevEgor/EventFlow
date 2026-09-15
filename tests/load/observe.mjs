import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { cpus, totalmem, platform } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import pg from 'pg';

const execute = promisify(execFile);
export function machine(replicas) {
  const docker = JSON.parse(
    execFileSync('docker', ['info', '--format', '{{json .}}'], {
      encoding: 'utf8',
      windowsHide: true,
    }),
  );
  const containers = JSON.parse(
    execFileSync(
      'docker',
      ['inspect', 'eventflow-local-postgres-1', 'eventflow-local-rabbitmq-1'],
      { encoding: 'utf8', windowsHide: true },
    ),
  );
  return {
    os: platform(),
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    ramBytes: totalmem(),
    node: process.version,
    docker: { version: docker.ServerVersion, cpus: docker.NCPU, memoryBytes: docker.MemTotal },
    containers: containers.map((c) => ({
      image: c.Config.Image,
      cpuLimit: c.HostConfig.NanoCpus,
      memoryLimitBytes: c.HostConfig.Memory,
    })),
    topology: `Catalog + first Booking replica in one Node process; ${replicas - 1} extra Booking child processes. Shared PostgreSQL/RabbitMQ in local Docker and separate k6 process. Direct API.`,
  };
}
export async function observe(booking, directory, write) {
  const observer = new pg.Client({
    connectionString: booking.databaseUrl,
    application_name: 'load-observer',
  });
  await observer.connect();
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  const samples = [],
    docker = [];
  let stopped = false,
    timer,
    running,
    failure,
    previousCpu = process.cpuUsage(),
    previousTime = performance.now(),
    count = 0;
  async function sample() {
    const now = performance.now(),
      cpu = process.cpuUsage(previousCpu);
    previousCpu = process.cpuUsage();
    const activity =
      await observer.query(`SELECT count(*)::int AS sessions, count(*) FILTER (WHERE state='active')::int AS active,
      count(*) FILTER (WHERE wait_event_type='Lock')::int AS lock_waiters,
      coalesce(max(extract(epoch FROM clock_timestamp()-query_start)*1000) FILTER (WHERE state='active'),0)::float AS longest_active_query_ms
      FROM pg_stat_activity WHERE datname=current_database() AND application_name='eventflow-booking'`);
    samples.push({
      at: new Date().toISOString(),
      ...booking.db.diagnostics(),
      ...activity.rows[0],
      nodeCpuPercentOneCore: (cpu.user + cpu.system) / (now - previousTime) / 10,
      nodeRss: process.memoryUsage().rss,
      eventLoopP99Ms: lag.percentile(99) / 1e6,
    });
    previousTime = now;
    lag.reset();
    if (count++ % 5 === 0) {
      const { stdout } = await execute(
        'docker',
        [
          'stats',
          '--no-stream',
          '--format',
          '{{json .}}',
          'eventflow-local-postgres-1',
          'eventflow-local-rabbitmq-1',
        ],
        { windowsHide: true },
      );
      docker.push({
        at: new Date().toISOString(),
        containers: stdout
          .trim()
          .split(/\r?\n/)
          .map((line) => JSON.parse(line)),
      });
    }
  }
  function schedule() {
    timer = setTimeout(() => {
      running = sample()
        .catch((error) => {
          failure ??= error;
        })
        .finally(() => {
          if (!stopped) schedule();
        });
    }, 1000);
  }
  schedule();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await running;
    lag.disable();
    await observer.end();
    write(`${directory}/diagnostics.json`, { samples, docker });
    if (failure) throw new Error('Load diagnostics failed', { cause: failure });
    return samples;
  };
}
