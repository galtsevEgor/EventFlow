import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { updatesStream } from '../helpers/realtime.mjs';
import { eventually } from '../helpers/eventually.mjs';

const args = process.argv.slice(2);
assert.ok(
  args.length === 0 || (args.length === 1 && args[0] === '--smoke'),
  'Use test:realtime-load [--smoke]',
);
const smoke = args[0] === '--smoke',
  clients = smoke ? 8 : 24,
  durationMs = smoke ? 12000 : 40000,
  changeAfterMs = Math.floor(durationMs / 2 / 5000) * 5000 + 2500;
const directory = resolve('work/realtime', randomUUID());
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
  const allowed = readFileSync(`/proc/${pid}/status`, 'utf8').match(
    /^Cpus_allowed_list:\s*(\d+)/m,
  )?.[1];
  assert.ok(allowed, 'Cannot determine an allowed CPU');
  execFileSync('taskset', ['-pc', allowed, String(pid)], { stdio: 'pipe', windowsHide: true });
  return `cpu-${allowed}`;
}
async function run(mode) {
  const child = fork(new URL('../helpers/realtime-load-child.mjs', import.meta.url), {
    execArgv: [],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  const messages = [];
  let output = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (data) => {
      output = (output + data).slice(-3000);
    });
  child.on('message', (message) => messages.push(message));
  const closed = new Promise((resolve) => child.once('close', resolve));
  const wait = (type) =>
    eventually(() => {
      if (child.exitCode !== null) throw new Error(`Profile child exited: ${output}`);
      const error = messages.find((m) => m.type === 'error');
      if (error) throw new Error(error.message);
      return messages.find((m) => m.type === type);
    }, Boolean);
  const streams = [],
    pollers = [],
    states = Array.from({ length: clients }, () => ({
      revision: 0,
      seenAt: 0,
      busy: false,
      dirty: false,
    }));
  let snapshots = 0,
    errors = 0;
  try {
    const ready = await wait('ready'),
      cpuAffinity = affinity(child.pid),
      url = `${ready.origin}/api/v1/sales/${ready.saleId}`;
    const warm = await fetch(url);
    assert.equal(warm.status, 200);
    await warm.body.cancel();
    const snapshot = async (index) => {
      const state = states[index];
      state.dirty = true;
      if (state.busy) return;
      state.busy = true;
      try {
        do {
          state.dirty = false;
          snapshots++;
          const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
          if (response.status !== 200) {
            await response.body.cancel();
            errors++;
            continue;
          }
          const data = await response.json();
          assert.equal(data.seats.length, 1000);
          if (data.revision > state.revision) {
            state.revision = data.revision;
            state.seenAt = Date.now();
          }
        } while (state.dirty);
      } finally {
        state.busy = false;
      }
    };
    child.send({ type: 'begin' });
    await wait('begun');
    const started = performance.now();
    if (mode === 'polling') {
      await Promise.all(states.map((_, index) => snapshot(index)));
      for (let index = 0; index < clients; index++)
        pollers.push(
          setInterval(() => {
            void snapshot(index).catch(() => errors++);
          }, 5000),
        );
    } else {
      await Promise.all(
        states.map(async (_, index) => {
          const stream = await updatesStream(url + '/updates');
          streams.push(stream);
          assert.equal(stream.response.status, 200);
          await stream.wait('ready');
          let seen = 0;
          const interval = setInterval(() => {
            const count = stream.frames.filter(
              (frame) => frame.kind === 'ready' || frame.kind === 'changed',
            ).length;
            if (count > seen) {
              seen = count;
              void snapshot(index).catch(() => errors++);
            }
          }, 20);
          pollers.push(interval);
          pollers.push(
            setInterval(() => {
              void snapshot(index).catch(() => errors++);
            }, 30000),
          );
        }),
      );
    }
    await sleep(Math.max(0, changeAfterMs - (performance.now() - started)));
    child.send({ type: 'change' });
    const change = await wait('changed');
    await sleep(Math.max(0, durationMs - (performance.now() - started)));
    for (const timer of pollers) clearInterval(timer);
    await eventually(() => states.every((state) => !state.busy), Boolean);
    assert.equal(errors, 0, 'Snapshot failures');
    assert.ok(
      states.every((state) => state.revision === change.revision),
      'Some clients missed the latest snapshot',
    );
    child.send({ type: 'measure' });
    const { report } = await wait('measured');
    const values = states.map((state) => state.seenAt - change.changedAt).sort((a, b) => a - b);
    const latencyMs = {
      p50: values[Math.floor(values.length * 0.5)],
      p95: values[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)],
      max: values.at(-1),
    };
    return {
      mode,
      clients,
      durationMs,
      cpuAffinity,
      snapshotRequests: snapshots,
      streamConnections: streams.length,
      errors,
      latencyMs,
      ...report,
    };
  } finally {
    for (const timer of pollers) clearInterval(timer);
    for (const stream of streams) await stream.close();
    if (child.exitCode === null && child.connected) child.send({ type: 'stop' });
    const deadline = setTimeout(() => child.kill('SIGKILL'), 10000);
    try {
      assert.equal(await closed, 0, 'Profile child did not shut down cleanly');
    } finally {
      clearTimeout(deadline);
    }
  }
}
const polling = await run('polling'),
  sse = await run('sse');
assert.equal(polling.cpuAffinity, sse.cpuAffinity, 'CPU allocation changed');
assert.ok(sse.snapshotRequests < polling.snapshotRequests, 'SSE did not reduce snapshot requests');
const report = {
  profile: smoke ? 'smoke' : 'comparison',
  node: process.version,
  scope:
    'One BFF and synthetic 1000-seat HTTP upstream in a child process; Redis and RabbitMQ are real, SQL/SSR/browser rendering are not measured.',
  pollIntervalMs: 5000,
  sseSafetyPollMs: 30000,
  changeAfterMs,
  polling,
  sse,
  snapshotReductionPercent: (1 - sse.snapshotRequests / polling.snapshotRequests) * 100,
};
writeFileSync(resolve(directory, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ directory, ...report }, null, 2));
