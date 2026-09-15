import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { kubeOutput, kubectl } from '../../scripts/cluster/local.mjs';

const [mode] = process.argv.slice(2);
assert.ok(['compare', 'autoscale', 'smoke'].includes(mode), 'Use compare, autoscale or smoke');
const worker = 'deployment/tickets-worker';
const scaledObject = 'scaledobject/tickets-worker';
const count = mode === 'smoke' ? 10 : 1000;
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

try {
  if (mode === 'compare') {
    await measure('queue-single', 1);
    await measure('queue-replicas', 3);
  } else await measure('queue-' + mode, 1);
} finally {
  if (mode === 'autoscale') {
    const annotations = JSON.parse(kubeOutput(['get', scaledObject, '-o', 'json'])).metadata
      .annotations;
    if (annotations?.['autoscaling.keda.sh/paused-replicas'] !== undefined)
      kubectl(['annotate', scaledObject, 'autoscaling.keda.sh/paused-replicas-']);
  } else scale(original);
}
