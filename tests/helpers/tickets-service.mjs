import { createApplication } from '../../packages/service-runtime/dist/index.js';
import { MessageWorker } from '../../packages/messaging/dist/index.js';
import { AppModule } from '../../services/tickets/dist/app.module.js';
import { readTicketsConfig } from '../../services/tickets/dist/config.js';
import { ticketsDatabase } from './tickets-database.mjs';

export async function ticketsService(namespace, overrides = {}) {
  const fixture = await ticketsDatabase();
  let app;
  async function close() {
    try {
      await app?.close();
    } finally {
      await fixture.close();
    }
  }
  try {
    const config = readTicketsConfig({
      ...process.env,
      TICKETS_DATABASE_URL: fixture.url,
      MESSAGE_NAMESPACE: namespace,
      ...overrides,
    });
    app = await createApplication(AppModule.configure(config));
    await app.listen(0, '127.0.0.1');
    return {
      db: fixture.db,
      origin: await app.getUrl(),
      worker: app.get(MessageWorker),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
