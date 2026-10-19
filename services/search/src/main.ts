import 'reflect-metadata';
import { readServiceConfig, startApplication } from '@eventflow/service-runtime';
import { AppModule } from './app.module';
import { readSearchConfig } from './config';
startApplication(
  AppModule.configure(readSearchConfig(process.env)),
  readServiceConfig(process.env, { name: 'search', port: 4005 }),
).catch(() => {
  console.error('Search startup failed. Check its local dependencies.');
  process.exitCode = 1;
});
