import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { defer, finalize } from 'rxjs';
import { ApiError } from './http';

export class HttpAdmission implements NestInterceptor {
  private active = 0;
  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error('Invalid HTTP concurrency limit');
  }

  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<Request>();
    if (['/health/live', '/health/ready'].includes(request.path)) return next.handle();
    if (this.active >= this.limit)
      throw new ApiError(503, 'HTTP_BUSY', 'Сервис занят. Повторите запрос позже.');
    this.active++;
    // Count the handler until its work completes, including after a client disconnects.
    return defer(() => next.handle()).pipe(
      finalize(() => {
        this.active--;
      }),
    );
  }
}
