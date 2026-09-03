import 'reflect-metadata';
import { readServiceConfig, startApplication } from '@eventflow/service-runtime';
import { AppModule } from './app.module';

const config = readServiceConfig(process.env, { name: 'bff', port: 4000 });

startApplication(AppModule, config).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
