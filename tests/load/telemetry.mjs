import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { eventually } from '../helpers/eventually.mjs';

const args = process.argv.slice(2);
assert.ok(
  args.length === 0 || (args.length === 1 && args[0] === '--smoke'),
  'Use test:telemetry-load [--smoke]',
);
const smoke = args[0] === '--smoke',
  durationMs = smoke ? 4000 : 20000,
  rate = smoke ? 10 : 40;
const directory = resolve('work/telemetry-load', randomUUID());
mkdirSync(directory, { recursive: true });
function affinity(pid) {
  if (smoke) return 'unrestricted-smoke';
  if (process.platform === 'win32')
    return execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$taskProc=[Diagnostics.Process]::GetProcessById(${pid});$taskMask=$taskProc.ProcessorAffinity.ToInt64();$taskCore=$taskMask -band (-$taskMask);$taskProc.ProcessorAffinity=[IntPtr]::new($taskCore);Write-Output $taskProc.ProcessorAffinity.ToInt64()`,
      ],
      { encoding: 'utf8', windowsHide: true },
    ).trim();
  const cpu = readFileSync(`/proc/${pid}/status`, 'utf8').match(
    /^Cpus_allowed_list:\s*(\d+)/m,
  )?.[1];
  assert.ok(cpu, 'Cannot identify allowed CPU');
  execFileSync('taskset', ['-pc', cpu, String(pid)], { stdio: 'pipe', windowsHide: true });
  return `cpu-${cpu}`;
}
async function run(enabled) {
  const child = fork(new URL('../helpers/telemetry-load-child.mjs', import.meta.url), {
    execArgv: [],
    env: {
      ...process.env,
      EVENTFLOW_TELEMETRY_ENABLED: String(enabled),
      EVENTFLOW_ENVIRONMENT: 'test',
      EVENTFLOW_TRACE_SAMPLE_RATIO: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  const messages = [];
  let output = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (data) => {
      output = (output + data).slice(-2000);
    });
  child.on('message', (message) => messages.push(message));
  const closed = new Promise((resolve) => child.once('close', resolve));
  const wait = (type) =>
    eventually(
      () => {
        if (child.exitCode !== null) throw new Error(`Telemetry child exited: ${output}`);
        if (messages.some((message) => message.type === 'error'))
          throw new Error('Telemetry child failed');
        return messages.find((message) => message.type === type);
      },
      Boolean,
      30000,
    );
  try {
    const ready = await wait('ready'),
      cpuAffinity = affinity(child.pid),
      url = `${ready.origin}/api/v1/sales/${ready.saleId}`;
    async function request() {
      const started = performance.now();
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).seats.length, 1000);
      return performance.now() - started;
    }
    for (let i = 0; i < 20; i++) await request();
    child.send({ type: 'begin' });
    await wait('begun');
    const started = performance.now(),
      pending = new Set(),
      latencies = [];
    let errors = 0,
      dropped = 0,
      maxScheduleLagMs = 0;
    const count = (durationMs / 1000) * rate;
    for (let index = 0; index < count; index++) {
      await sleep(Math.max(0, started + (index * 1000) / rate - performance.now()));
      maxScheduleLagMs = Math.max(
        maxScheduleLagMs,
        performance.now() - started - (index * 1000) / rate,
      );
      if (pending.size >= 16) {
        dropped++;
        continue;
      }
      const job = request()
        .then(
          (ms) => latencies.push(ms),
          () => errors++,
        )
        .finally(() => pending.delete(job));
      pending.add(job);
    }
    await Promise.all(pending);
    child.send({ type: 'measure' });
    const measured = await wait('measured');
    assert.equal(errors, 0);
    assert.equal(dropped, 0, 'The load driver exceeded its concurrency budget');
    assert.equal(latencies.length, count);
    latencies.sort((a, b) => a - b);
    return {
      enabled,
      cpuAffinity,
      requests: count,
      errors,
      dropped,
      maxScheduleLagMs,
      actualRequestsPerSecond: count / (measured.wallMs / 1000),
      p95Ms: latencies[Math.ceil(count * 0.95) - 1],
      meanMs: latencies.reduce((a, b) => a + b, 0) / count,
      ...measured,
      type: undefined,
    };
  } finally {
    if (child.connected) child.send({ type: 'stop' });
    const kill = setTimeout(() => child.kill('SIGKILL'), 15000);
    await closed;
    clearTimeout(kill);
    assert.equal(child.exitCode, 0, 'Profile child did not shut down cleanly');
  }
}
const results = [];
for (const enabled of smoke ? [false, true] : [false, true, true, false]) {
  const result = await run(enabled);
  results.push(result);
  console.log(JSON.stringify(result));
}
assert.equal(new Set(results.map((result) => result.cpuAffinity)).size, 1);
const average = (enabled, key) => {
  const rows = results.filter((result) => result.enabled === enabled);
  return rows.reduce((sum, row) => sum + row[key], 0) / rows.length;
};
const report = {
  smoke,
  durationMs,
  rate,
  traceSampleRatio: 1,
  scope:
    'One BFF and a synthetic 1000-seat HTTP upstream in one process; real Redis/RabbitMQ and Collector. Excludes SQL, SSR and external providers. Collector CPU is outside the application CPU measurement.',
  results,
  overhead: Object.fromEntries(
    ['cpuMs', 'p95Ms', 'rssPeakMiB'].map((key) => [
      key,
      {
        off: average(false, key),
        on: average(true, key),
        percent: (average(true, key) / average(false, key) - 1) * 100,
      },
    ]),
  ),
};
writeFileSync(resolve(directory, 'results.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`Telemetry comparison passed; local report: ${directory}`);
