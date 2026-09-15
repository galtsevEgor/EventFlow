import { Broker, MessageWorker } from '../../packages/messaging/dist/index.js';
import { commerceRoutes } from '../../packages/event-contracts/dist/index.js';
import { Database } from '../../services/tickets/dist/database.js';
import { IssueTickets } from '../../services/tickets/dist/issue.js';
import { QrCredentials } from '../../services/tickets/dist/qr-credentials.js';
import { eventually } from './eventually.mjs';

const db = new Database(process.env.TICKETS_DATABASE_URL);
const issue = new IssueTickets(db, new QrCredentials(process.env.TICKET_QR_KEYS));
const worker = new MessageWorker(
  new Broker({
    url: process.env.AMQP_URL,
    namespace: process.env.MESSAGE_NAMESPACE,
    consumer: 'tickets',
    routes: commerceRoutes,
  }),
  undefined,
  async (event) => {
    await issue.handle(event);
    process.send({ type: 'committed', eventId: event.eventId });
    // Only this test child pauses between the real SQL commit and the broker's acknowledgement.
    if (process.env.TICKETS_TEST_CRASH === '1') await new Promise(() => {});
  },
);
await db.$connect();
worker.start();
await eventually(() => worker.broker.ready, Boolean);
process.send({ type: 'ready' });
process.on('message', async (message) => {
  if (message === 'stop') {
    await worker.stop();
    await db.$disconnect();
    process.disconnect();
  }
});
