import {
  Controller,
  Get,
  Inject,
  Injectable,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import {
  APPROVED_COVER_MIME_TYPE,
  COVER_MULTIPART_LIMITS,
  COVER_UPLOAD_FIELD,
} from '@eventflow/event-contracts';
import { ApiError } from '@eventflow/service-runtime';
import { AuthService } from './auth/auth.service';
import type { Session } from './auth/session-store';

const COVER_UPLOAD_RATE_LIMIT = 8;
const COVER_PROXY_TIMEOUT_MS = 20_000;

interface CoverRequest extends Request {
  session: Session;
}
type ImageUpload = { buffer: Buffer; mimetype: string; size: number };
@Injectable()
export class CoverSessionGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<CoverRequest>();
    const { session } = await this.auth.requireSession(request);
    if (request.method === 'POST') {
      this.auth.assertCsrf(request, session.csrf);
      await this.auth.store.rateLimit(`cover:${session.user.sub}`, COVER_UPLOAD_RATE_LIMIT);
    }
    request.session = session;
    return true;
  }
}

@Controller('api/v1')
export class CoverProxyController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  @Post('organizations/:id/events/:eventId/cover')
  @UseGuards(CoverSessionGuard)
  @UseInterceptors(FileInterceptor(COVER_UPLOAD_FIELD, { limits: COVER_MULTIPART_LIMITS }))
  async upload(
    @Req() request: CoverRequest,
    @Res() response: Response,
    @UploadedFile() file: ImageUpload | undefined,
  ) {
    if (!file) throw new ApiError(422, 'FILE_REQUIRED', 'Выберите файл афиши.');
    const body = new FormData();
    body.set(
      COVER_UPLOAD_FIELD,
      new Blob([new Uint8Array(file.buffer)], { type: file.mimetype }),
      'cover',
    );
    return this.forward(request, response, request.session.accessToken, body);
  }
  @Get('organizations/:id/events/:eventId/cover')
  @UseGuards(CoverSessionGuard)
  preview(@Req() request: CoverRequest, @Res() response: Response) {
    return this.forward(request, response, request.session.accessToken);
  }
  @Get('covers/:id') publicCover(@Req() request: Request, @Res() response: Response) {
    return this.forward(request, response);
  }

  private async forward(request: Request, response: Response, token?: string, body?: FormData) {
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(new URL(request.path, this.auth.config.CATALOG_URL), {
        method: request.method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          'x-request-id': response.locals.requestId,
          traceparent: response.locals.traceparent,
        },
        ...(body ? { body } : {}),
        signal: AbortSignal.timeout(COVER_PROXY_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch {
      throw new ApiError(503, 'COVER_UNAVAILABLE', 'Работа с афишами временно недоступна.');
    }
    if (upstream.status >= 500)
      throw new ApiError(503, 'COVER_UNAVAILABLE', 'Работа с афишами временно недоступна.');
    response.status(upstream.status);
    if (upstream.headers.get('content-type')?.startsWith(APPROVED_COVER_MIME_TYPE)) {
      response.setHeader('content-type', APPROVED_COVER_MIME_TYPE);
      response.setHeader(
        'cache-control',
        upstream.headers.get('cache-control') ?? 'private, no-store',
      );
      const etag = upstream.headers.get('etag');
      if (etag) response.setHeader('etag', etag);
      response.send(Buffer.from(await upstream.arrayBuffer()));
    } else response.json(await upstream.json());
  }
}
