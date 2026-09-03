import 'reflect-metadata';
import type { Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { ServiceConfig } from './config';

export async function createApplication(rootModule: Type<unknown>) {
  const app = await NestFactory.create(rootModule, { logger: ['error', 'warn', 'log'] });
  app.enableShutdownHooks();
  return app;
}

export async function startApplication(rootModule: Type<unknown>, config: ServiceConfig) {
  const app = await createApplication(rootModule);
  await app.listen(config.port, config.host);
  return app;
}
