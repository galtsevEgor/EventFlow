import { Database } from '../../services/payments/dist/database.js';
import { BookingClient } from '../../services/payments/dist/booking-client.js';
import { FakePaymentProvider } from '../../services/payments/dist/providers/fake.js';
import { ProcessAttempt } from '../../services/payments/dist/attempts/process.js';
import { ProcessRefund } from '../../services/payments/dist/refunds/process.js';

if (!process.send) throw new Error('Payment fixture requires an owned IPC process.');
const db = new Database(process.env.PAYMENTS_DATABASE_URL);
await db.$connect();
process.on('message', async (command) => {
  if (command === 'stop') {
    await db.$disconnect();
    process.exit(0);
  }
  try {
    const provider = new FakePaymentProvider(db);
    if (command.pauseAfterEffect) {
      const operation = command.kind === 'payment' ? 'create' : 'refund';
      const original = provider[operation].bind(provider);
      provider[operation] = async (input) => {
        await original(input);
        process.send({ type: 'effect' });
        // Simulate a provider response in flight, without a transaction or test hook in production.
        return new Promise(() => {});
      };
    }
    const processor =
      command.kind === 'payment'
        ? new ProcessAttempt(db, new BookingClient(process.env), provider)
        : new ProcessRefund(db, provider);
    process.send({ type: 'done', claimed: await processor.run(command.id) });
  } catch {
    process.send({ type: 'failed' });
  }
});
process.send({ type: 'ready' });
