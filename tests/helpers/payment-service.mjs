import { createApplication } from '../../packages/service-runtime/dist/index.js';
import { AppModule } from '../../services/payments/dist/app.module.js';
import { Database } from '../../services/payments/dist/database.js';
import { ProcessAttempt } from '../../services/payments/dist/attempts/process.js';
import { ProcessRefund } from '../../services/payments/dist/refunds/process.js';
import { Reconciler } from '../../services/payments/dist/reconciler.js';
import { paymentsDatabase } from './payments-database.mjs';

// Shared infrastructure, but a separate owned database and a real Payments HTTP server.
export async function paymentService(namespace, bookingUrl, overrides = {}) {
  const persistence = await paymentsDatabase();
  let app;
  async function close() {
    await app?.close();
    await persistence.close();
  }
  try {
    app = await createApplication(
      AppModule.configure({
        PAYMENTS_DATABASE_URL: persistence.url,
        BOOKING_URL: bookingUrl,
        AMQP_URL: process.env.AMQP_URL,
        MESSAGE_NAMESPACE: namespace,
        OIDC_ISSUER: process.env.OIDC_ISSUER,
        PAYMENTS_CLIENT_SECRET: process.env.PAYMENTS_CLIENT_SECRET,
        PAYMENT_PROVIDER: 'fake',
        ...overrides,
      }),
      { rawBody: true },
    );
    app.useLogger(false);
    await app.listen(0, '127.0.0.1');
    return {
      app,
      db: app.get(Database),
      provider: app.get('PAYMENT_PROVIDER'),
      processor: app.get(ProcessAttempt),
      refunds: app.get(ProcessRefund),
      reconciler: app.get(Reconciler),
      origin: await app.getUrl(),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
