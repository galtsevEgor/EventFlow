import 'reflect-metadata';
import { localServicePorts, readServiceConfig, startApplication } from '@eventflow/service-runtime';
import { AppModule } from './app.module';
import { readAnalyticsConfig } from './config';
startApplication(
  AppModule.configure(readAnalyticsConfig(process.env)),
  readServiceConfig(process.env, { name: 'analytics', port: localServicePorts.analytics }),
).catch(() => {
  console.error('Analytics startup failed. Check local dependencies.');
  process.exitCode = 1;
});
