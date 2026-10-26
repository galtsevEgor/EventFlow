import 'reflect-metadata';
import { readServiceConfig, startApplication } from '@eventflow/service-runtime';
import { AppModule } from './app.module';
import { readWaitlistConfig } from './config';
startApplication(
  AppModule.configure(readWaitlistConfig(process.env)),
  readServiceConfig(process.env, { name: 'waitlist', port: 4007 }),
).catch(() => {
  console.error('Waitlist startup failed. Check local dependencies.');
  process.exitCode = 1;
});
