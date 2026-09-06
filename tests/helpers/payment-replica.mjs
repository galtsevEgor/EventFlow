import { fork } from 'node:child_process';

export async function paymentReplica(fixture) {
  const child = fork(new URL('./payment-child.mjs', import.meta.url), {
    execArgv: [],
    silent: true,
    windowsHide: true,
    env: {
      ...process.env,
      PAYMENTS_DATABASE_URL: fixture.databaseUrl,
      BOOKING_URL: fixture.booking.origin,
      OIDC_ISSUER: fixture.identity.issuer,
      PAYMENTS_CLIENT_SECRET: fixture.identity.serviceSecret,
    },
  });
  const closed = new Promise((resolve) => child.once('exit', resolve));
  // Drain diagnostics without risking raw provider or identity data in the test report.
  child.stdout.resume();
  child.stderr.resume();
  function wait(type) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error(`Payment worker did not reach ${type}`)),
        15000,
      );
      function finish(error, result) {
        clearTimeout(timer);
        child.off('message', receive);
        child.off('exit', failed);
        child.off('error', failed);
        if (error) reject(error);
        else resolve(result);
      }
      const failed = () => finish(new Error(`Payment worker stopped before ${type}`));
      const receive = (message) => {
        if (message.type === 'failed') failed();
        else if (message.type === type) finish(null, message);
      };
      child.on('message', receive);
      child.once('exit', failed);
      child.once('error', failed);
    });
  }
  async function close(crash = false) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (crash) child.kill('SIGKILL');
    else child.send('stop');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      await closed;
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    await wait('ready');
    return {
      close,
      pid: child.pid,
      async run(kind, id, pauseAfterEffect = false) {
        const done = wait(pauseAfterEffect ? 'effect' : 'done');
        child.send({ kind, id, pauseAfterEffect });
        return done;
      },
    };
  } catch (error) {
    await close(true);
    throw error;
  }
}
