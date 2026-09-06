import 'reflect-metadata';
import { readServiceConfig, startApplication } from '@eventflow/service-runtime';
import { AppModule } from './app.module';
import { readBookingConfig } from './config';

const config = readServiceConfig(process.env, { name: 'booking', port: 4002 });

startApplication(AppModule.configure(readBookingConfig(process.env)), config).catch(() => {
  console.error('Booking startup failed. Check its database and messaging configuration.');
  process.exitCode = 1;
});
