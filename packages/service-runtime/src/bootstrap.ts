import 'reflect-metadata';
import { Module, type Type, type DynamicModule } from '@nestjs/common';
import { initializeTelemetry, instrumentFetch } from '@eventflow/telemetry';
import { NestFactory } from '@nestjs/core';
import type { Request, Response, NextFunction } from 'express';
import type { ServiceConfig } from './config';
import { ApiExceptionFilter, requestContext } from './http';
import { HttpAdmission } from './http-admission';

@Module({})
class RuntimeModule {}
@Module({})
class TelemetryModule {}

export async function createApplication(
  rootModule: Type<unknown> | DynamicModule,
  options: { rawBody?: boolean; httpConcurrency?: number; name?: string } = {},
) {
  const {
    name = process.env.OTEL_SERVICE_NAME ?? 'service',
    httpConcurrency = Number(process.env.EVENTFLOW_HTTP_CONCURRENCY ?? 64),
    ...nestOptions
  } = options;
  const telemetry = initializeTelemetry(name);
  if (telemetry.config.enabled) instrumentFetch();
  const admission = new HttpAdmission(httpConcurrency);
  const app = await NestFactory.create(
    {
      module: RuntimeModule,
      imports: [
        {
          module: TelemetryModule,
          providers: [
            {
              provide: 'TELEMETRY_LIFECYCLE',
              useValue: { onApplicationShutdown: () => telemetry.shutdown() },
            },
          ],
        },
        rootModule,
      ],
    },
    {
      logger: ['error', 'warn', 'log'],
      ...nestOptions,
    },
  );
  app.enableShutdownHooks();
  app.use((request: Request, response: Response, next: NextFunction) =>
    requestContext(request, response, next, telemetry),
  );
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalInterceptors(admission);
  return app;
}

export async function startApplication(
  rootModule: Type<unknown> | DynamicModule,
  config: ServiceConfig,
  options: { rawBody?: boolean } = {},
) {
  const app = await createApplication(rootModule, { ...options, name: config.name });
  await app.listen(config.port, config.host);
  return app;
}
