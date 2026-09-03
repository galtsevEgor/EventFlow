import 'reflect-metadata';
import { readServiceConfig, startApplication } from '@eventflow/service-runtime';
import { AppModule } from './app.module';

const config = readServiceConfig(process.env, { name: 'catalog', port: 4001 });

startApplication(AppModule, config).catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
