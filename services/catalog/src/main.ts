import 'reflect-metadata';
import { readServiceConfig, startApplication } from '@eventflow/service-runtime';
import { AppModule } from './app.module';
import { readCatalogConfig } from './config';

const config = readServiceConfig(process.env, { name: 'catalog', port: 4001 });

startApplication(AppModule.configure(readCatalogConfig(process.env)), config).catch(() => {
  console.error('Catalog startup failed. Check its database and identity configuration.');
  process.exitCode = 1;
});
