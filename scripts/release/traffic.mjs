const windowMs = 300_000;
const sampleLimit = 4096;

export function traffic(clock = Date.now) {
  const samples = [];
  let index = 0;
  return {
    observe(status, durationMs) {
      samples[index++ % sampleLimit] = { at: clock(), status, durationMs };
    },
    snapshot() {
      const since = clock() - windowMs;
      const recent = samples.filter(({ at }) => at >= since);
      const sorted = recent.map(({ durationMs }) => durationMs).sort((a, b) => a - b);
      return {
        requests: recent.length,
        serverErrors: recent.filter(({ status }) => status >= 500).length,
        p95Ms: Math.round(sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0),
      };
    },
  };
}

export function alerts(metrics) {
  const active = [];
  for (const name of ['web', 'rabbitmq', 'catalog', 'booking', 'payments', 'tickets']) {
    if (!metrics[name]) active.push(name.toUpperCase() + '_UNAVAILABLE');
  }
  if (metrics.rabbitmq?.dead > 0) active.push('RABBIT_DLQ');
  if (metrics.rabbitmq?.pending > 100) active.push('RABBIT_BACKLOG');
  for (const name of ['catalog', 'booking', 'payments', 'tickets']) {
    const database = metrics[name];
    if (database?.outboxAgeSeconds > 60) active.push(name.toUpperCase() + '_OUTBOX_STALLED');
    if (database?.lockWaiters > 0) active.push(name.toUpperCase() + '_LOCK_WAIT');
    if (database?.mailDead > 0) active.push(name.toUpperCase() + '_MAIL_DEAD');
  }
  if (metrics.payments?.paymentAgeSeconds > 300) active.push('PAYMENT_STALLED');
  if (metrics.payments?.refundAgeSeconds > 300) active.push('REFUND_STALLED');
  if (metrics.web?.requests >= 10) {
    if (metrics.web.serverErrors / metrics.web.requests > 0.05) active.push('HTTP_5XX');
    if (metrics.web.p95Ms > 750) active.push('HTTP_LATENCY');
  }
  return active;
}
