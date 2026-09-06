import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID } from 'node:crypto';
const require = createRequire(new URL('../../services/payments/package.json', import.meta.url));
export const Stripe = require('stripe');

// Synthetic HTTP contract server, deliberately distinct from the real sandbox acceptance job.
export async function stripeContract() {
  const secret = `sk_test_${randomBytes(16).toString('hex')}`;
  const signingSecret = `whsec_${randomBytes(16).toString('hex')}`;
  const input = {
    orderId: randomUUID(),
    attemptId: randomUUID(),
    amountMinor: 1500,
    currency: 'EUR',
  };
  const state = {
    requests: [],
    refunds: [],
    failCancel: false,
    failRequest: false,
    payment: {
      id: 'pi_contractPayment',
      object: 'payment_intent',
      livemode: false,
      amount: input.amountMinor,
      amount_received: 0,
      currency: 'eur',
      capture_method: 'automatic',
      payment_method_types: ['card'],
      status: 'requires_payment_method',
      client_secret: 'synthetic-client-secret',
      metadata: { application: 'eventflow', orderId: input.orderId, attemptId: input.attemptId },
    },
  };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = new URLSearchParams(Buffer.concat(chunks).toString());
    state.requests.push({
      path: req.url,
      method: req.method,
      key: req.headers['idempotency-key'],
      version: req.headers['stripe-version'],
      fields: Object.fromEntries(body),
    });
    res.setHeader('content-type', 'application/json');
    if (state.failRequest || (req.url.endsWith('/cancel') && state.failCancel)) {
      res.statusCode = state.failRequest ? 503 : 400;
      res.end(
        JSON.stringify({ error: { type: 'invalid_request_error', message: 'Synthetic failure' } }),
      );
      return;
    }
    if (req.url.startsWith('/v1/refunds')) {
      if (req.method === 'GET')
        res.end(JSON.stringify({ object: 'list', data: state.refunds, has_more: false }));
      else {
        const refund = {
          id: 're_contractRefund',
          object: 'refund',
          payment_intent: body.get('payment_intent'),
          amount: Number(body.get('amount')),
          currency: 'eur',
          status: 'succeeded',
          metadata: {
            application: body.get('metadata[application]'),
            operationId: body.get('metadata[operationId]'),
          },
        };
        if (!state.refunds.length) state.refunds.push(refund);
        res.end(JSON.stringify(state.refunds[0]));
      }
    } else res.end(JSON.stringify(state.payment));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new Stripe(secret, {
    host: '127.0.0.1',
    port: server.address().port,
    protocol: 'http',
    timeout: 1000,
    maxNetworkRetries: 0,
  });
  return {
    secret,
    signingSecret,
    client,
    input,
    state,
    sign(payload, timestamp) {
      return client.webhooks.generateTestHeaderString({
        payload,
        secret: signingSecret,
        ...(timestamp ? { timestamp } : {}),
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
