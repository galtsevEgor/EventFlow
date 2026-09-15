import { createServer } from 'node:http';
import pg from 'pg';
import { alerts } from './traffic.mjs';

const databaseNames = ['catalog', 'booking', 'payments', 'tickets'];
const pools = new Map(
  databaseNames.map((name) => [
    name,
    new pg.Pool({
      connectionString: process.env[`${name.toUpperCase()}_DATABASE_URL`],
      max: 1,
      connectionTimeoutMillis: 2500,
      statement_timeout: 2500,
      options: '-c default_transaction_read_only=on',
    }),
  ]),
);
for (const pool of pools.values()) pool.on('error', () => {});

const outbox = `(SELECT COALESCE(EXTRACT(EPOCH FROM (now() - min("availableAt"))), 0)::int
  FROM "Outbox" WHERE "sentAt" IS NULL) AS "outboxAgeSeconds"`;
const delivery = `(SELECT count(*)::int FROM "DeliveryJob" WHERE state = 'DEAD') AS "mailDead"`;
const payments = `(SELECT COALESCE(EXTRACT(EPOCH FROM (now() - min("createdAt"))), 0)::int
  FROM "PaymentAttempt" WHERE state IN ('PROCESSING', 'NEEDS_RECONCILIATION', 'REQUIRES_REVIEW')) AS "paymentAgeSeconds",
  (SELECT COALESCE(EXTRACT(EPOCH FROM (now() - min("createdAt"))), 0)::int
  FROM "RefundOperation" WHERE state <> 'SUCCEEDED') AS "refundAgeSeconds"`;
const extra = {
  catalog: [outbox, delivery],
  booking: [outbox],
  payments: [outbox, payments],
  tickets: [delivery],
};
async function database(name) {
  const result = await pools.get(name).query(`SELECT
    count(*)::int AS connections,
    count(*) FILTER (WHERE wait_event_type = 'Lock')::int AS "lockWaiters",
    ${extra[name].join(', ')}
    FROM pg_stat_activity WHERE datname = current_database()`);
  return result.rows[0];
}

const amqp = new URL(process.env.AMQP_URL);
const rabbitAuth = Buffer.from(
  decodeURIComponent(amqp.username) + ':' + decodeURIComponent(amqp.password),
).toString('base64');
async function json(url, headers) {
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(2500),
    headers,
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('Monitor target unavailable');
  }
  return response.json();
}
async function rabbit() {
  const queues = await json('http://rabbitmq:15672/api/queues/%2F', {
    authorization: 'Basic ' + rabbitAuth,
  });
  return {
    queues: queues.length,
    pending: queues.reduce((sum, item) => sum + Number(item.messages ?? 0), 0),
    dead: queues
      .filter(({ name }) => name.endsWith('.dlq'))
      .reduce((sum, item) => sum + Number(item.messages ?? 0), 0),
  };
}
async function web() {
  await json(`http://app:${process.env.RELEASE_PORT}/api/v1/events`);
  return json('http://app:9101/');
}
let latest = { sampledAt: null, metrics: {}, alerts: [] };
let stopped = false;
let timer;
async function sample() {
  const names = ['web', 'rabbitmq', ...databaseNames];
  const results = await Promise.allSettled([web(), rabbit(), ...databaseNames.map(database)]);
  const metrics = Object.fromEntries(
    results.map((result, index) => [
      names[index],
      result.status === 'fulfilled' ? result.value : null,
    ]),
  );
  const next = alerts(metrics);
  for (const alert of next)
    if (!latest.alerts.includes(alert))
      console.warn(JSON.stringify({ kind: 'monitor_alert', alert }));
  for (const alert of latest.alerts)
    if (!next.includes(alert)) console.info(JSON.stringify({ kind: 'monitor_resolved', alert }));
  latest = { sampledAt: new Date().toISOString(), metrics, alerts: next };
  if (!stopped) timer = setTimeout(() => void sample(), 5000);
}

function dashboard() {
  const rows = Object.entries(latest.metrics)
    .map(
      ([target, values]) =>
        `<tr><th scope="row">${target}</th><td>${
          values
            ? Object.entries(values)
                .map(([key, value]) => `${key}=${Number(value)}`)
                .join(' · ')
            : 'Недоступен'
        }</td></tr>`,
    )
    .join('');
  const warnings = latest.alerts.map((alert) => `<li>${alert}</li>`).join('');
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="10">
  <title>Мониторинг EventFlow</title><style>
  body{font:1rem system-ui;margin:2rem auto;padding:0 1rem;max-width:65rem;color:#142720}
  table{width:100%;border-collapse:collapse}th,td{text-align:left;border-bottom:1px solid #ccc;padding:.65rem;overflow-wrap:anywhere}
  li{color:#9a240f}
  </style><main><h1>Мониторинг EventFlow</h1><p>Обновлено ${latest.sampledAt ?? '—'}</p>
  <h2>Активные сигналы</h2>${warnings ? `<ul>${warnings}</ul>` : '<p>Активных сигналов нет.</p>'}
  <h2>Показатели</h2><table><thead><tr><th>Компонент</th><th>Значения</th></tr></thead><tbody>${rows}</tbody></table>
  <p><a href="/api/status">JSON</a></p></main></html>`;
}

const server = createServer((request, response) => {
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader(
    'content-security-policy',
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  );
  if (request.method === 'GET' && request.url === '/api/status') {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(latest));
  } else if (request.method === 'GET' && request.url === '/') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(dashboard());
  } else response.writeHead(404).end();
});
server.listen(9090, '0.0.0.0');
void sample();
process.on('SIGTERM', () => {
  stopped = true;
  clearTimeout(timer);
  server.close();
  for (const pool of pools.values()) void pool.end();
});
