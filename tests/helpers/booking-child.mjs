import { createApplication } from '../../packages/service-runtime/dist/index.js';
import { AppModule } from '../../services/booking/dist/app.module.js';
import { readBookingConfig } from '../../services/booking/dist/config.js';
import { OrderSweeper } from '../../services/booking/dist/orders/sweeper.js';

if (!process.send) throw new Error('This fixture must be started with an owned IPC child process.');
const app = await createApplication(AppModule.configure(readBookingConfig(process.env)));
app.useLogger(false);
await app.listen(0, '127.0.0.1');
const sweeper = app.get(OrderSweeper);
await sweeper.stop();
process.on('message', async (command) => {
  if (command === 'sweep') {
    await sweeper.sweep();
    process.send({ type: 'swept' });
  }
  if (command === 'stop') {
    await app.close();
    process.exit(0);
  }
});
process.send({ type: 'ready', origin: await app.getUrl() });
