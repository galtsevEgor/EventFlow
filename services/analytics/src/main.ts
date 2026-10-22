import 'reflect-metadata';
import { readServiceConfig, startApplication } from '@eventflow/service-runtime';
import { AppModule } from './app.module';
import { readAnalyticsConfig } from './config';
startApplication(
  AppModule.configure(readAnalyticsConfig(process.env)),
  readServiceConfig(process.env, { name: 'analytics', port: 4006 }),
).catch(() => {
  console.error('Analytics startup failed. Check local dependencies.');
  process.exitCode = 1;
});
