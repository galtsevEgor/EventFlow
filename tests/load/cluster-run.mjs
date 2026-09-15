import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import { kubeOutput, kubectl } from '../../scripts/cluster/local.mjs';
import { toolPath } from '../../scripts/quality-tools.mjs';

const directory = resolve('work/e7/load');
mkdirSync(directory, { recursive: true });
const [mode] = process.argv.slice(2);
const profiles = [
  { name: 'single', replicas: 1, cpu: '900m' },
  { name: 'replicas-same-cpu', replicas: 3, cpu: '300m' },
  { name: 'replicas-more-cpu', replicas: 3, cpu: '600m' },
];
const applications = ['deployment/storefront', 'deployment/bff'];

function configure({ replicas, cpu }) {
  kubectl(['set', 'resources', ...applications, '-c', 'http', '--limits', 'cpu=' + cpu]);
  kubectl(['scale', '--replicas=' + replicas, ...applications]);
  for (const app of applications) kubectl(['rollout', 'status', app, '--timeout=2m']);
}

function sample() {
  const pods = JSON.parse(
    kubeOutput(['get', 'pods', '-l', 'app.kubernetes.io/component=http', '-o', 'json']),
  ).items;
  const db = kubeOutput([
    'exec',
    'deployment/postgres',
    '--',
    'psql',
    '-U',
    'eventflow_admin',
    '-d',
    'postgres',
    '-At',
    '-c',
    `SELECT json_build_object('connections', count(*), 'waitingOnLock',
      count(*) FILTER (WHERE wait_event_type = 'Lock')) FROM pg_stat_activity WHERE backend_type = 'client backend'`,
  ]);
  return {
    at: new Date().toISOString(),
    podRestarts: Object.fromEntries(
      pods.map((pod) => [pod.metadata.name, pod.status.containerStatuses?.[0]?.restartCount ?? 0]),
    ),
    postgres: JSON.parse(db),
    resources: kubeOutput(['top', 'pods', '--no-headers'])
      .split(/\r?\n/)
      .map((line) => {
        const [pod, cpu, memory] = line.trim().split(/\s+/);
        return { pod, cpu, memory };
      }),
  };
}

async function run(label, { smoke = false } = {}) {
  const summary = resolve(directory, label + '.k6.json');
  const child = spawn(toolPath('k6'), ['run', '--quiet', 'tests/load/cluster-catalog.k6.js'], {
    env: {
      ...process.env,
      PROFILE: smoke ? 'smoke' : 'comparison',
      RESULT: summary,
      K6_NO_USAGE_REPORT: 'true',
    },
    windowsHide: true,
    stdio: 'inherit',
  });
  const finished = once(child, 'exit');
  let done = false;
  void finished.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  const samples = [];
  try {
    while (!done) {
      if (!smoke) samples.push(sample());
      await Promise.race([delay(5000, undefined, { ref: false }), finished]);
    }
  } finally {
    if (!done) child.kill();
  }
  const [code, signal] = await finished;
  assert.equal(code, 0, `k6 failed (${code ?? signal})`);
  const { metrics } = JSON.parse(readFileSync(summary, 'utf8'));
  assert.ok(metrics.http_reqs.values.count >= 50, 'Too few requests for comparison');
  writeFileSync(resolve(directory, label + '.samples.json'), JSON.stringify(samples, null, 2));
  return metrics;
}

if (mode === 'smoke') {
  await run('smoke', { smoke: true });
} else if (mode === 'compare') {
  assert.equal(kubeOutput(['get', 'hpa', '-o', 'name']), '', 'Use a fixed cluster profile');
  const original = applications.map((app) => {
    const { spec } = JSON.parse(kubeOutput(['get', app, '-o', 'json']));
    const http = spec.template.spec.containers.find(({ name }) => name === 'http');
    return { app, replicas: spec.replicas, cpu: http.resources.limits?.cpu ?? null };
  });
  try {
    for (const profile of profiles) {
      configure(profile);
      await run('warmup', { smoke: true });
      await run(profile.name);
    }
  } finally {
    for (const { app, replicas, cpu } of original) {
      kubectl([
        'patch',
        app,
        '--type=strategic',
        '-p',
        JSON.stringify({
          spec: {
            replicas,
            template: { spec: { containers: [{ name: 'http', resources: { limits: { cpu } } }] } },
          },
        }),
      ]);
      kubectl(['rollout', 'status', app, '--timeout=2m']);
    }
  }
} else throw new Error('Use smoke or compare.');
