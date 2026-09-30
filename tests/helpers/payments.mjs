import { randomUUID } from 'node:crypto';
import { createApplication } from '../../packages/service-runtime/dist/index.js';
import { AppModule } from '../../services/payments/dist/app.module.js';
import { Database } from '../../services/payments/dist/database.js';
import { ProcessAttempt } from '../../services/payments/dist/attempts/process.js';
import { Reconciler } from '../../services/payments/dist/reconciler.js';
import { bookingFixture } from './booking.mjs';
import { paymentsDatabase } from './payments-database.mjs';
import { testIdentity } from './identity.mjs';
import { cleanBroker } from './broker.mjs';

export async function paymentsFixture() {
  const namespace = `eventflow-test-${randomUUID()}`;
  const identity = await testIdentity();
  let booking, persistence, app;
  async function close() {
    await app?.close();
    await booking?.close();
    await persistence?.close();
    await identity.close();
    await cleanBroker(namespace);
  }
  try {
    booking = await bookingFixture(namespace, 0, { OIDC_ISSUER: identity.issuer });
    persistence = await paymentsDatabase();
    app = await createApplication(
      AppModule.configure({
        PAYMENTS_DATABASE_URL: persistence.url,
        BOOKING_URL: booking.origin,
        AMQP_URL: process.env.AMQP_URL,
        MESSAGE_NAMESPACE: namespace,
        OIDC_ISSUER: identity.issuer,
        PAYMENTS_CLIENT_SECRET: identity.serviceSecret,
        PAYMENT_PROVIDER: 'fake',
      }),
      { name: 'payments' },
    );
    app.useLogger(false);
    await app.listen(0, '127.0.0.1');
    await app.get(Reconciler).stop();
    return {
      app,
      db: app.get(Database),
      databaseUrl: persistence.url,
      provider: app.get('PAYMENT_PROVIDER'),
      processor: app.get(ProcessAttempt),
      booking,
      identity,
      namespace,
      origin: await app.getUrl(),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
