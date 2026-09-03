import 'reflect-metadata';
import { readServiceConfig, startApplication } from '@eventflow/service-runtime';
import { AppModule } from './app.module';
import { readAuthConfig } from './auth/config';

const config = readServiceConfig(process.env, { name: 'bff', port: 4000 });

startApplication(AppModule.configure(readAuthConfig(process.env)), config).catch(() => {
  console.error('BFF startup failed. Check identity and Redis configuration.');
  process.exitCode = 1;
});
