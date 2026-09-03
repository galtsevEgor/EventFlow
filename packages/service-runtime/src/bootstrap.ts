import 'reflect-metadata';
import type { Type, DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { ServiceConfig } from './config';
import { ApiExceptionFilter, requestContext } from './http';

export async function createApplication(rootModule: Type<unknown> | DynamicModule) {
  const app = await NestFactory.create(rootModule, { logger: ['error', 'warn', 'log'] });
  app.enableShutdownHooks();
  app.use(requestContext);
  app.useGlobalFilters(new ApiExceptionFilter());
  return app;
}

export async function startApplication(
  rootModule: Type<unknown> | DynamicModule,
  config: ServiceConfig,
) {
  const app = await createApplication(rootModule);
  await app.listen(config.port, config.host);
  return app;
}
