import { fork } from 'node:child_process';

export async function bookingReplica(databaseUrl, namespace, issuer, poolSize) {
  const child = fork(new URL('./booking-child.mjs', import.meta.url), {
    execArgv: [],
    env: {
      ...process.env,
      BOOKING_DATABASE_URL: databaseUrl,
      MESSAGE_NAMESPACE: namespace,
      OIDC_ISSUER: issuer,
      EVENTFLOW_LOG_REQUESTS: '0',
      ...(poolSize ? { DATABASE_POOL_SIZE: String(poolSize) } : {}),
    },
    silent: true,
    windowsHide: true,
  });
  const closed = new Promise((resolve) => child.once('exit', resolve));
  let output = '';
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      output = (output + chunk).slice(-2000);
    });
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
  function wait(type) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => finish(new Error(`Booking child did not send ${type}: ${output}`)),
        15000,
      );
      const failed = () => finish(new Error(`Booking child stopped before ${type}: ${output}`));
      const received = (message) => {
        if (message.type === type) finish(null, message);
      };
      function finish(error, message) {
        clearTimeout(timeout);
        child.off('message', received);
        child.off('exit', failed);
        child.off('error', failed);
        if (error) reject(error);
        else resolve(message);
      }
      child.on('message', received);
      child.once('exit', failed);
      child.once('error', failed);
    });
  }
  try {
    const { origin } = await wait('ready');
    return {
      origin,
      pid: child.pid,
      close,
      async sweep() {
        const done = wait('swept');
        child.send('sweep');
        await done;
      },
    };
  } catch (error) {
    await close(true);
    throw error;
  }
}
