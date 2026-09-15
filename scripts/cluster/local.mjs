import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { initializeEnvironment } from '../local-env.mjs';
import { manifest, output, run } from '../release/local.mjs';
import { withEnvironmentLock } from '../release/compatibility.mjs';
import { toolPath } from '../quality-tools.mjs';

export const name = 'eventflow-scale';
export const directory = resolve('work/e7');
const kubeconfig = resolve(directory, 'kubeconfig.yaml');
const context = 'k3d-' + name;
const chart = 'infra/kubernetes/eventflow';
const credentials = resolve(directory, 'credentials');
const runtimeKeys = [
  'OIDC_CLIENT_SECRET',
  'POLICY_CLIENT_SECRET',
  'PAYMENTS_CLIENT_SECRET',
  'PAYMENTS_OPERATOR_SECRET',
  'TICKET_DELIVERY_CLIENT_SECRET',
  'MAIL_OPERATOR_SECRET',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'TICKET_QR_KEYS',
  'BOOKING_CONTACT_KEY',
  'CATALOG_INVITATION_KEY',
];
const infraKeys = [
  'POSTGRES_ADMIN_PASSWORD',
  'KEYCLOAK_ADMIN_PASSWORD',
  'KEYCLOAK_DB_PASSWORD',
  'CATALOG_DB_PASSWORD',
  'BOOKING_DB_PASSWORD',
  'PAYMENTS_DB_PASSWORD',
  'TICKETS_DB_PASSWORD',
  'REDIS_PASSWORD',
  'RABBITMQ_PASSWORD',
];

function tool(binary) {
  if (binary === 'helm') return toolPath('helm');
  const local = resolve(directory, 'tools', binary + (process.platform === 'win32' ? '.exe' : ''));
  return existsSync(local) ? local : binary;
}

export function kubectl(args, options) {
  return run(
    tool('kubectl'),
    ['--kubeconfig', kubeconfig, '--context', context, '-n', name, ...args],
    options,
  );
}

export function kubeOutput(args) {
  return kubectl(args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' }).trim();
}

export function helm(args, options, namespace = name) {
  return run(
    tool('helm'),
    ['--kubeconfig', kubeconfig, '--kube-context', context, '-n', namespace, ...args],
    options,
  );
}

function ensureCluster() {
  const clusters = JSON.parse(output(tool('k3d'), ['cluster', 'list', '-o', 'json']));
  const cluster = clusters?.find((cluster) => cluster.name === name);
  if (cluster && !cluster.serversRunning) run(tool('k3d'), ['cluster', 'start', name]);
  if (!cluster) {
    run(tool('k3d'), [
      'cluster',
      'create',
      name,
      '--image',
      'rancher/k3s:v1.34.3-k3s1',
      '--api-port',
      '127.0.0.1:58443',
      '--port',
      '127.0.0.1:58000:30080@loadbalancer',
      '--port',
      '127.0.0.1:58080:30081@loadbalancer',
      '--port',
      '127.0.0.1:58025:30025@loadbalancer',
      '--k3s-arg',
      '--disable=traefik@server:0',
      '--k3s-arg',
      '--disable=servicelb@server:0',
      '--kubeconfig-update-default=false',
      '--kubeconfig-switch-context=false',
      '--wait',
    ]);
  }
  writeFileSync(kubeconfig, output(tool('k3d'), ['kubeconfig', 'get', name]) + '\n', {
    mode: 0o600,
  });
}

function apply(kind, resourceName, body, namespaced = true) {
  kubectl(['apply', '--server-side', '--field-manager=eventflow-local', '-f', '-'], {
    input: JSON.stringify({
      apiVersion: 'v1',
      kind,
      metadata: { name: resourceName, ...(namespaced ? { namespace: name } : {}) },
      ...body,
    }),
    stdio: ['pipe', 'inherit', 'inherit'],
  });
}

function secret(resourceName, entries) {
  apply('Secret', resourceName, {
    type: 'Opaque',
    data: Object.fromEntries(
      Object.entries(entries).map(([key, value]) => [key, Buffer.from(value).toString('base64')]),
    ),
  });
}

function initialize() {
  mkdirSync(credentials, { recursive: true });
  initializeEnvironment(credentials);
  const env = parseEnv(readFileSync(resolve(credentials, '.env'), 'utf8'));
  const usersPath = resolve(credentials, 'demo-users.json');
  if (!existsSync(usersPath)) {
    const users = ['owner', 'manager', 'staff', 'outsider'].map((username) => ({
      username,
      email: `${username}@eventflow.test`,
      password: randomBytes(18).toString('base64url'),
    }));
    writeFileSync(usersPath, JSON.stringify(users, null, 2), { mode: 0o600 });
  }
  const runtime = Object.fromEntries(runtimeKeys.map((key) => [key, env[key]]));
  for (const service of ['catalog', 'booking', 'payments', 'tickets']) {
    const prefix = service.toUpperCase();
    runtime[prefix + '_DATABASE_URL'] =
      `postgresql://${service}:${env[prefix + '_DB_PASSWORD']}@postgres:5432/${service}`;
  }
  runtime.REDIS_URL = `redis://:${env.REDIS_PASSWORD}@redis:6379`;
  runtime.AMQP_URL = `amqp://eventflow:${env.RABBITMQ_PASSWORD}@rabbitmq:5672`;
  runtime.RABBITMQ_MANAGEMENT_URL = `http://eventflow:${env.RABBITMQ_PASSWORD}@rabbitmq.${name}.svc.cluster.local:15672`;
  apply('Namespace', name, {}, false);
  secret('eventflow-infra', Object.fromEntries(infraKeys.map((key) => [key, env[key]])));
  secret('eventflow-runtime', runtime);
  secret('eventflow-demo-users', { 'demo-users.json': readFileSync(usersPath) });
  secret('eventflow-s3', { 's3.json': readFileSync(resolve(credentials, 'work/local/s3.json')) });
  apply('ConfigMap', 'eventflow-postgres-init', {
    data: {
      '01-databases.sh': readFileSync('infra/compose/postgres-init.sh', 'utf8').replaceAll(
        '\r\n',
        '\n',
      ),
    },
  });
}

function deploymentImage(service) {
  return kubeOutput([
    'get',
    'deployment',
    service,
    '--ignore-not-found',
    '-o',
    'jsonpath={.spec.template.spec.containers[0].image}',
  ]);
}

export async function up(releaseId, profile = 'single') {
  if (!['single', 'replicas', 'autoscale'].includes(profile))
    throw new Error('Unknown cluster profile.');
  mkdirSync(directory, { recursive: true });
  return withEnvironmentLock({ directory, name }, async () => {
    const release = manifest(releaseId);
    const splitWorkers = Boolean(
      output('git', [
        'ls-tree',
        '--name-only',
        release.id,
        '--',
        'packages/service-runtime/src/workload.ts',
      ]),
    );
    if (profile === 'autoscale' && !splitWorkers)
      throw new Error('Autoscale requires an image with dedicated worker mode.');
    ensureCluster();
    initialize();
    const image = `eventflow-release:${release.id}`;
    if (output('docker', ['image', 'inspect', '--format', '{{.Id}}', image]) !== release.image)
      throw new Error('Local image tag does not match the release.');
    helm([
      'upgrade',
      '--install',
      'eventflow-infra',
      chart,
      '--set',
      'mode=infrastructure',
      '--wait',
      '--timeout',
      '5m',
    ]);
    if (profile === 'autoscale') {
      helm(
        [
          'upgrade',
          '--install',
          'keda',
          'keda',
          '--repo',
          'https://kedacore.github.io/charts',
          '--version',
          '2.18.2',
          '--create-namespace',
          '--wait',
          '--timeout',
          '6m',
        ],
        undefined,
        'keda',
      );
    }
    const images = output('docker', [
      'exec',
      'k3d-' + name + '-server-0',
      'ctr',
      '--address',
      '/run/k3s/containerd/containerd.sock',
      '--namespace',
      'k8s.io',
      'images',
      'ls',
      '-q',
    ]);
    if (!images.split(/\r?\n/).includes('docker.io/library/' + image)) {
      run(tool('k3d'), ['image', 'import', image, '-c', name]);
    }
    const previous = deploymentImage('storefront');
    const retained =
      previous && previous !== image ? previous : deploymentImage('storefront-retained');
    helm([
      'upgrade',
      '--install',
      'eventflow',
      chart,
      '--set-string',
      `image=${image}`,
      '--set-string',
      `deploymentId=${release.id}`,
      '--set-string',
      `retained.image=${retained}`,
      '--set-string',
      `retained.deploymentId=${retained.split(':')[1] ?? ''}`,
      '--set',
      `splitWorkers=${splitWorkers}`,
      ...(profile !== 'single' ? ['-f', chart + '/values.' + profile + '.yaml'] : []),
      '--wait',
      '--timeout',
      '6m',
    ]);
    kubectl(['get', 'pods', '-o', 'wide']);
    console.log('EventFlow cluster ready at http://127.0.0.1:58000');
  });
}

export function check() {
  run(tool('helm'), ['lint', chart, '--set-string', 'image=eventflow-release:fixture']);
  run(tool('helm'), [
    'lint',
    chart,
    '-f',
    chart + '/values.replicas.yaml',
    '--set-string',
    'image=eventflow-release:fixture,retained.image=eventflow-release:previous',
  ]);
  run(tool('helm'), [
    'lint',
    chart,
    '-f',
    chart + '/values.autoscale.yaml',
    '--set-string',
    'image=eventflow-release:fixture',
  ]);
  run(tool('helm'), ['lint', chart, '--set', 'mode=infrastructure']);
}
