import { randomBytes, randomUUID } from 'node:crypto';
import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { Telemetry, traceContext, SpanKind, SpanStatusCode } from '@eventflow/telemetry';

export class ApiError extends HttpException {
  constructor(
    status: number,
    code: string,
    message: string,
    fieldErrors?: Record<string, string[]>,
  ) {
    super({ code, message, ...(fieldErrors ? { fieldErrors } : {}) }, status);
  }
}

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const fields: Record<string, string[]> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || 'form';
    (fields[key] ??= []).push(issue.message);
  }
  throw new ApiError(422, 'VALIDATION_FAILED', 'Проверьте заполненные поля.', fields);
}

export function requestContext(
  request: Request,
  response: Response,
  next: NextFunction,
  telemetry?: Telemetry,
) {
  const started = performance.now();
  const incoming = request.header('x-request-id');
  const requestId = incoming && z.uuid().safeParse(incoming).success ? incoming : randomUUID();
  const parent = request.header('traceparent');
  const validTrace =
    parent && /^00-(?!0{32}-)[a-f0-9]{32}-(?!0{16}-)[a-f0-9]{16}-0[01]$/.test(parent);
  const span =
    telemetry?.config.enabled &&
    !['/health/live', '/health/ready', '/metrics'].includes(request.path)
      ? telemetry.start(
          'http.server',
          {
            kind: SpanKind.SERVER,
            attributes: { 'http.request.method': request.method },
          },
          traceContext(parent),
        )
      : undefined;
  const traceId =
    span?.spanContext().traceId ??
    (validTrace ? parent.split('-')[1] : randomBytes(16).toString('hex'));
  response.locals.requestId = requestId;
  response.locals.traceparent = `00-${traceId}-${span?.spanContext().spanId ?? randomBytes(8).toString('hex')}-${span && !(span.spanContext().traceFlags & 1) ? '00' : '01'}`;
  response.setHeader('x-request-id', requestId);
  response.setHeader('traceparent', response.locals.traceparent);
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('cache-control', 'no-store');
  let ended = false;
  const finish = (status: number) => {
    if (ended) return;
    ended = true;
    if (span) {
      span.setAttribute('http.response.status_code', status);
      if (typeof request.route?.path === 'string')
        span.setAttribute('http.route', request.route.path);
      if (status >= 500 || status === 499) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
    }
  };
  response.once('close', () => finish(response.writableFinished ? response.statusCode : 499));
  response.once('finish', () => {
    finish(response.statusCode);
    if (process.env.EVENTFLOW_LOG_REQUESTS !== '0')
      console.info(JSON.stringify(accessLog(request, response, performance.now() - started)));
  });
  if (span && telemetry) telemetry.within(span, next);
  else next();
}

export function accessLog(
  request: Pick<Request, 'method'>,
  response: Pick<Response, 'statusCode' | 'locals'>,
  duration: number,
) {
  // Explicit allowlist: URLs, headers, cookies, bodies and tokens never enter access logs.
  return {
    kind: 'http',
    method: request.method,
    status: response.statusCode,
    requestId: response.locals.requestId,
    traceId: String(response.locals.traceparent).split('-')[1],
    durationMs: Math.round(duration),
  };
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : 500;
    const defaults: Record<number, [string, string]> = {
      400: ['BAD_REQUEST', 'Некорректный запрос.'],
      401: ['UNAUTHENTICATED', 'Войдите в аккаунт.'],
      403: ['FORBIDDEN', 'Недостаточно прав.'],
      404: ['NOT_FOUND', 'Объект не найден.'],
      413: ['PAYLOAD_TOO_LARGE', 'Файл слишком большой. Максимум 5 MiB.'],
      415: ['UNSUPPORTED_MEDIA_TYPE', 'Этот тип файла не поддерживается.'],
      429: ['RATE_LIMITED', 'Слишком много запросов. Повторите позже.'],
      503: ['DEPENDENCY_UNAVAILABLE', 'Сервис временно недоступен. Повторите позже.'],
    };
    const [code, message] = defaults[status] ?? ['INTERNAL_ERROR', 'Не удалось выполнить запрос.'];
    const error = exception instanceof ApiError ? exception.getResponse() : { code, message };
    if (status === 429 || status === 503) response.setHeader('retry-after', '5');
    response.setHeader('cache-control', 'no-store');
    response.status(status).json({
      ...(typeof error === 'object' ? error : { code, message }),
      requestId: response.locals.requestId,
      retryable: status === 503 || status === 429,
    });
  }
}
