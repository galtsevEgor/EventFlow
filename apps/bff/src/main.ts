import 'reflect-metadata';
import { localServicePorts, readServiceConfig, startApplication } from '@eventflow/service-runtime';
import { AppModule } from './app.module';
import { readAuthConfig } from './auth/config';

const config = readServiceConfig(process.env, { name: 'bff', port: localServicePorts.bff });

startApplication(AppModule.configure(readAuthConfig(process.env)), config, { rawBody: true }).catch(
  () => {
    console.error('BFF startup failed. Check identity and Redis configuration.');
    process.exitCode = 1;
  },
);
