import 'reflect-metadata';
import type { Type, DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { ServiceConfig } from './config';
import { ApiExceptionFilter, requestContext } from './http';

export async function createApplication(
  rootModule: Type<unknown> | DynamicModule,
  options: { rawBody?: boolean } = {},
) {
  const app = await NestFactory.create(rootModule, {
    logger: ['error', 'warn', 'log'],
    ...options,
  });
  app.enableShutdownHooks();
  app.use(requestContext);
  app.useGlobalFilters(new ApiExceptionFilter());
  return app;
}

export async function startApplication(
  rootModule: Type<unknown> | DynamicModule,
  config: ServiceConfig,
  options: { rawBody?: boolean } = {},
) {
  const app = await createApplication(rootModule, options);
  await app.listen(config.port, config.host);
  return app;
}
