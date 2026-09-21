import 'reflect-metadata';
import type { Type, DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { ServiceConfig } from './config';
import { ApiExceptionFilter, requestContext } from './http';
import { HttpAdmission } from './http-admission';

export async function createApplication(
  rootModule: Type<unknown> | DynamicModule,
  options: { rawBody?: boolean; httpConcurrency?: number } = {},
) {
  const { httpConcurrency = Number(process.env.EVENTFLOW_HTTP_CONCURRENCY ?? 64), ...nestOptions } =
    options;
  const admission = new HttpAdmission(httpConcurrency);
  const app = await NestFactory.create(rootModule, {
    logger: ['error', 'warn', 'log'],
    ...nestOptions,
  });
  app.enableShutdownHooks();
  app.use(requestContext);
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalInterceptors(admission);
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
