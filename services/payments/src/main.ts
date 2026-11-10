import 'reflect-metadata';
import { localServicePorts, readServiceConfig, startApplication } from '@eventflow/service-runtime';
import { AppModule } from './app.module';
import { readPaymentsConfig } from './config';

const config = readServiceConfig(process.env, {
  name: 'payments',
  port: localServicePorts.payments,
});

startApplication(AppModule.configure(readPaymentsConfig(process.env)), config, {
  rawBody: true,
}).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
