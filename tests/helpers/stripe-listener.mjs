import { spawn } from 'node:child_process';
import { toolPath } from '../../scripts/quality-tools.mjs';

export async function stripeListener(config) {
  const child = spawn(
    toolPath('stripe'),
    [
      'listen',
      '--skip-update',
      '--events-from',
      '@self',
      '--events',
      'payment_intent.succeeded,payment_intent.payment_failed,payment_intent.processing,payment_intent.canceled,refund.created,refund.updated,refund.failed',
      '--forward-to',
      config.webhookUrl,
      '--color',
      'off',
    ],
    {
      env: {
        ...process.env,
        STRIPE_API_KEY: config.secret,
        STRIPE_DEVICE_NAME: 'eventflow-sandbox-tests',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  const closed = new Promise((resolve) => child.once('close', resolve));
  async function close() {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      await closed;
    } finally {
      clearTimeout(timer);
    }
  }
  try {
    const secret = await new Promise((resolve, reject) => {
      let buffer = '';
      let ready = false;
      const timeout = setTimeout(
        () => reject(new Error('Stripe listener did not become ready within 30 seconds.')),
        30000,
      );
      const fail = () => {
        clearTimeout(timeout);
        if (!ready)
          reject(
            new Error('Stripe listener failed. Check sandbox access and run pnpm tools:setup.'),
          );
      };
      child.once('error', fail);
      child.once('close', fail);
      const receive = (chunk) => {
        if (ready) return;
        buffer = (buffer + chunk).slice(-8192);
        const found = buffer.match(/whsec_[A-Za-z0-9]+/);
        if (found) {
          ready = true;
          buffer = '';
          clearTimeout(timeout);
          resolve(found[0]);
        }
      };
      child.stdout.on('data', receive);
      child.stderr.on('data', receive);
    });
    return {
      secret,
      close,
      assertRunning() {
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error('Stripe listener stopped during the test.');
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
