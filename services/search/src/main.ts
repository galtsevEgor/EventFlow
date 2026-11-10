import 'reflect-metadata';
import { localServicePorts, readServiceConfig, startApplication } from '@eventflow/service-runtime';
import { AppModule } from './app.module';
import { readSearchConfig } from './config';
startApplication(
  AppModule.configure(readSearchConfig(process.env)),
  readServiceConfig(process.env, { name: 'search', port: localServicePorts.search }),
).catch(() => {
  console.error('Search startup failed. Check its local dependencies.');
  process.exitCode = 1;
});
