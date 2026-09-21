import { randomUUID } from 'node:crypto';

export function createAdmission(options = {}, now = () => performance.now()) {
  const limits = {
    windowMs: 10000,
    maxClients: 2000,
    webhookConcurrent: 8,
    apiRequests: Number(process.env.EVENTFLOW_API_REQUESTS ?? 600),
    ssrRequests: Number(process.env.EVENTFLOW_SSR_REQUESTS ?? 120),
    apiConcurrent: Number(process.env.EVENTFLOW_API_CONCURRENCY ?? 32),
    ssrConcurrent: Number(process.env.EVENTFLOW_SSR_CONCURRENCY ?? 16),
    ...options,
  };
  for (const [key, value] of Object.entries(limits))
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid gateway limit: ${key}`);
  let started = now();
  const clients = new Map();
  const active = { api: 0, ssr: 0, webhook: 0 };

  function reject(request, response, status, retryAfter) {
    const requestId = randomUUID();
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': String(retryAfter),
      'x-request-id': requestId,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
    });
    response.end(
      JSON.stringify({
        code: status === 429 ? 'RATE_LIMITED' : 'HTTP_BUSY',
        message: 'Сервис занят. Повторите запрос позже.',
        requestId,
        retryable: true,
      }),
    );
    request.resume();
    return false;
  }

  return (request, response, group) => {
    if (!group) return true;
    const time = now();
    if (time - started >= limits.windowMs) {
      clients.clear();
      started = time;
    }
    if (group !== 'webhook') {
      // Forwarded headers cannot create extra client budgets.
      const client = request.socket.remoteAddress ?? 'unknown';
      let counts = clients.get(client);
      const retryAfter = Math.max(1, Math.ceil((limits.windowMs - (time - started)) / 1000));
      if (!counts) {
        if (clients.size >= limits.maxClients) return reject(request, response, 429, retryAfter);
        counts = { api: 0, ssr: 0 };
        clients.set(client, counts);
      }
      counts[group]++;
      if (counts[group] > limits[group + 'Requests'])
        return reject(request, response, 429, retryAfter);
    }
    if (active[group] >= limits[group + 'Concurrent']) return reject(request, response, 503, 1);
    active[group]++;
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        active[group]--;
      }
    };
    response.once('finish', release);
    response.once('close', release);
    return true;
  };
}
