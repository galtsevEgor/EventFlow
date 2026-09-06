import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    kind: { type: 'string' },
    id: { type: 'string' },
    key: { type: 'string' },
    reason: { type: 'string' },
    list: { type: 'boolean' },
  },
});
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
if (
  !values.list &&
  (!['payment', 'refund'].includes(values.kind) ||
    !uuid.test(values.id ?? '') ||
    !uuid.test(values.key ?? '') ||
    (values.reason?.trim().length ?? 0) < 8)
)
  throw new Error(
    'Use --list or --kind payment|refund --id UUID --key UUID --reason "Reason for reconciliation"',
  );
if (!process.env.PAYMENTS_OPERATOR_SECRET) throw new Error('PAYMENTS_OPERATOR_SECRET is required');
const identity = new URL(process.env.OIDC_ISSUER),
  payments = new URL(process.env.PAYMENTS_URL);
for (const url of [identity, payments])
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))
  )
    throw new Error('Operator endpoints require HTTPS outside loopback');
const tokenResponse = await fetch(
  `${identity.href.replace(/\/$/, '')}/protocol/openid-connect/token`,
  {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
    body: new URLSearchParams({
      client_id: 'eventflow-operator',
      client_secret: process.env.PAYMENTS_OPERATOR_SECRET,
      grant_type: 'client_credentials',
    }),
  },
);
if (!tokenResponse.ok)
  throw new Error(`Operator authentication failed: HTTP ${tokenResponse.status}`);
const { access_token: token } = await tokenResponse.json();
const response = await fetch(
  new URL(`/internal/payments/${values.list ? 'review' : 'reconcile'}`, payments),
  {
    method: values.list ? 'GET' : 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(values.key ? { 'idempotency-key': values.key } : {}),
    },
    ...(values.list
      ? {}
      : {
          body: JSON.stringify({ kind: values.kind, targetId: values.id, reason: values.reason }),
        }),
  },
);
if (!response.ok) throw new Error(`Reconciliation request failed: HTTP ${response.status}`);
console.log(JSON.stringify(await response.json(), null, 2));
