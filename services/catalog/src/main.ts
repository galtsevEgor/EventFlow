import 'reflect-metadata';
import { localServicePorts, readServiceConfig, startApplication } from '@eventflow/service-runtime';
import { AppModule } from './app.module';
import { readCatalogConfig } from './config';

const config = readServiceConfig(process.env, { name: 'catalog', port: localServicePorts.catalog });

startApplication(AppModule.configure(readCatalogConfig(process.env)), config).catch(() => {
  console.error('Catalog startup failed. Check its database and identity configuration.');
  process.exitCode = 1;
});
