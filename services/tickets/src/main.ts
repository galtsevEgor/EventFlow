import 'reflect-metadata';
import { localServicePorts, readServiceConfig, startApplication } from '@eventflow/service-runtime';
import { AppModule } from './app.module';
import { readTicketsConfig } from './config';

const config = readServiceConfig(process.env, { name: 'tickets', port: localServicePorts.tickets });

async function start() {
  await startApplication(AppModule.configure(readTicketsConfig(process.env)), config);
}

start().catch(() => {
  console.error(
    'Tickets startup failed. Check its database, identity, messaging and QR key configuration.',
  );
  process.exitCode = 1;
});
