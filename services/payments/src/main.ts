import 'reflect-metadata';
import { readServiceConfig, startApplication } from '@eventflow/service-runtime';
import { AppModule } from './app.module';
import { readPaymentsConfig } from './config';

const config = readServiceConfig(process.env, { name: 'payments', port: 4003 });

startApplication(AppModule.configure(readPaymentsConfig(process.env)), config).catch(
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);
