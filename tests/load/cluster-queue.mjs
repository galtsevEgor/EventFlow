import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { kubeOutput, kubectl } from '../../scripts/cluster/local.mjs';

const [mode] = process.argv.slice(2);
assert.ok(
  ['compare', 'autoscale', 'smoke', 'fault'].includes(mode),
  'Use compare, autoscale, smoke or fault',
);
const worker = 'deployment/tickets-worker';
const scaledObject = 'scaledobject/tickets-worker';
const count = { smoke: 10, fault: 1, autoscale: 2000 }[mode] ?? 1000;
const seats = 6;
const queue = 'eventflow.tickets';
const directory = 'work/e7/load';
mkdirSync(directory, { recursive: true });

function inTickets(source) {
  return kubectl(['exec', '-i', 'deployment/tickets', '--', 'node', '--input-type=module', '-'], {
    input: source,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
  }).trim();
}

function publish(buyer) {
  inTickets(`
    import { randomUUID } from 'node:crypto';
    import { once } from 'node:events';
    import { connect } from 'amqplib';
    import { message } from '/app/packages/event-contracts/dist/index.js';
    const connection = await connect(process.env.AMQP_URL);
    try {
      const channel = await connection.createConfirmChannel();
      const saleId = randomUUID(), organizationId = randomUUID();
      for (let index = 0; index < ${count}; index++) {
        const orderId = randomUUID();
        const envelope = message('booking', 'OrderConfirmed.v1', orderId, 2, {
          orderId, attemptId: randomUUID(), providerPaymentId: 'fake_load_' + orderId,
          saleId, organizationId, buyerSubject: ${JSON.stringify(buyer)}, title: 'Local queue fixture',
          totalMinor: ${seats} * 2500, currency: 'EUR', confirmedAt: new Date().toISOString(),
          items: Array.from({length: ${seats}}, (_, i) => ({
            seatId: 'r1-s' + (i + 1), row: 1, number: i + 1, categoryName: 'Standard', priceMinor: 2500,
          })),
        });
        if (!channel.sendToQueue(${JSON.stringify(queue)}, Buffer.from(JSON.stringify(envelope)), {persistent: true}))
          await once(channel, 'drain');
        if (index % 50 === 49) await channel.waitForConfirms();
      }
      await channel.waitForConfirms();
    } finally {
      await connection.close();
    }
  `);
}

function state(buyer, started) {
  return JSON.parse(
    inTickets(`
    import { Client } from 'pg';
    const client = new Client({ connectionString: process.env.TICKETS_DATABASE_URL });
    await client.connect();
    try {
      const { rows: [result] } = await client.query(
        'SELECT count(*)::int AS tickets, count(DISTINCT "orderId")::int AS orders, ' +
        'md5(string_agg(id::text || "qrHash", chr(44) ORDER BY id)) AS digest, ' +
        'percentile_cont(ARRAY[0.5, 0.95, 0.99]) WITHIN GROUP (ORDER BY ' +
        'EXTRACT(EPOCH FROM ("issuedAt" - $2::timestamptz)) * 1000) AS "ageMs" ' +
        'FROM "Ticket" WHERE "buyerSubject" = $1',
        [${JSON.stringify(buyer)}, ${JSON.stringify(started)}],
      );
      console.log(JSON.stringify(result));
    } finally {
      await client.end();
    }
  `),
  );
}

function queueDepth() {
  const rows = JSON.parse(
    kubeOutput([
      'exec',
      'deployment/rabbitmq',
      '--',
      'rabbitmqctl',
      '-q',
      'list_queues',
      '--formatter',
      'json',
      'name',
      'messages_ready',
      'messages_unacknowledged',
      'consumers',
    ]),
  );
  const current = rows.find(({ name }) => name === queue);
  assert.ok(current, 'Tickets queue unavailable');
  return current;
}

async function waitFor(test, timeout = 120000) {
  const deadline = Date.now() + timeout;
  do {
    const result = test();
    if (result) return result;
    await delay(1000);
  } while (Date.now() < deadline);
  throw new Error('Timed out waiting for ticket worker');
}

function scale(replicas) {
  if (mode === 'autoscale') {
    kubectl([
      'annotate',
      scaledObject,
      'autoscaling.keda.sh/paused-replicas=' + replicas,
      '--overwrite',
    ]);
  } else kubectl(['scale', worker, '--replicas=' + replicas]);
}

function desired() {
  return Number(kubeOutput(['get', worker, '-o', 'jsonpath={.spec.replicas}']));
}

if (mode !== 'autoscale')
  assert.equal(kubeOutput(['get', 'hpa', '-o', 'name']), '', 'Use a fixed cluster profile');
const original = desired();

async function measure(label, replicas) {
  scale(0);
  await waitFor(() => queueDepth().consumers === 0);
  assert.equal(
    queueDepth().messages_ready,
    0,
    'Use a dedicated cluster with an empty ticket queue',
  );
  const buyer = 'eventflow-load-' + randomUUID();
  const started = new Date().toISOString();
  publish(buyer);
  await waitFor(() => queueDepth().messages_ready === count);
  const releasedAt = Date.now();
  if (mode === 'autoscale')
    kubectl(['annotate', scaledObject, 'autoscaling.keda.sh/paused-replicas-']);
  else scale(replicas);
  const samples = [];
  const result = await waitFor(() => {
    const data = {
      elapsedMs: Date.now() - releasedAt,
      replicas: desired(),
      queue: queueDepth(),
      ...state(buyer, started),
    };
    samples.push(data);
    return data.orders === count &&
      data.queue.messages_ready + data.queue.messages_unacknowledged === 0
      ? data
      : null;
  });
  const maxReplicas = Math.max(...samples.map((sample) => sample.replicas));
  writeFileSync(
    directory + '/' + label + '.json',
    JSON.stringify({ count, seats, result, maxReplicas, samples }, null, 2),
  );
  assert.equal(result.tickets, count * seats);
  if (mode === 'autoscale') assert.ok(maxReplicas > 1, 'KEDA did not scale above one replica');
  console.log(
    `${label}: ${result.orders} orders, ${result.tickets} tickets, ${result.elapsedMs} ms, ${maxReplicas} replicas`,
  );
}

async function failAfterCommit() {
  const name = 'tickets-fault-' + randomUUID().slice(0, 8);
  const image = kubeOutput([
    'get',
    worker,
    '-o',
    'jsonpath={.spec.template.spec.containers[0].image}',
  ]);
  assert.match(image, /^eventflow-release:[a-f0-9]{40}$/);
  const buyer = 'eventflow-fault-' + randomUUID();
  const started = new Date().toISOString();
  scale(0);
  await waitFor(() => queueDepth().consumers === 0);
  assert.equal(queueDepth().messages_ready, 0);
  kubectl(['create', '-f', '-'], {
    input: JSON.stringify({
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name,
        labels: { 'app.kubernetes.io/name': 'tickets', 'app.kubernetes.io/component': 'fault' },
      },
      spec: {
        restartPolicy: 'Never',
        enableServiceLinks: false,
        automountServiceAccountToken: false,
        containers: [
          {
            name: 'consumer',
            image,
            imagePullPolicy: 'Never',
            command: [
              'node',
              '-e',
              `const { fork } = require('node:child_process');
            const child = fork('/app/tests/helpers/tickets-child.mjs', {execArgv: []});
            child.on('exit', code => process.exit(code ?? 1));`,
            ],
            env: [
              { name: 'MESSAGE_NAMESPACE', value: 'eventflow' },
              { name: 'TICKETS_TEST_CRASH', value: '1' },
              ...['TICKETS_DATABASE_URL', 'TICKET_QR_KEYS', 'AMQP_URL'].map((key) => ({
                name: key,
                valueFrom: { secretKeyRef: { name: 'eventflow-runtime', key } },
              })),
            ],
          },
        ],
      },
    }),
    stdio: ['pipe', 'inherit', 'inherit'],
  });
  try {
    await waitFor(() => queueDepth().consumers === 1);
    publish(buyer);
    const before = await waitFor(() => {
      const data = state(buyer, started);
      return data.tickets === seats && queueDepth().messages_unacknowledged === 1 ? data : null;
    });
    kubectl(['delete', 'pod', name, '--grace-period=0', '--force', '--wait=false']);
    scale(1);
    await waitFor(() => {
      const data = queueDepth();
      return data.consumers === 1 && data.messages_ready + data.messages_unacknowledged === 0;
    });
    const after = state(buyer, started);
    assert.deepEqual(after, before);
    writeFileSync(
      directory + '/queue-fault.json',
      JSON.stringify({ before, after, recovered: true }, null, 2),
    );
    console.log('RabbitMQ redelivered an unacknowledged order without changing its issued tickets');
  } finally {
    kubectl(['delete', 'pod', name, '--ignore-not-found', '--wait=false']);
  }
}

try {
  if (mode === 'compare') {
    await measure('queue-single', 1);
    await measure('queue-replicas', 3);
  } else if (mode === 'fault') {
    await failAfterCommit();
  } else await measure('queue-' + mode, 1);
} finally {
  if (mode === 'autoscale') {
    const annotations = JSON.parse(kubeOutput(['get', scaledObject, '-o', 'json'])).metadata
      .annotations;
    if (annotations?.['autoscaling.keda.sh/paused-replicas'] !== undefined)
      kubectl(['annotate', scaledObject, 'autoscaling.keda.sh/paused-replicas-']);
  } else scale(original);
}
