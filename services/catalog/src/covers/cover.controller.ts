import {
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import {
  APPROVED_COVER_MIME_TYPE,
  COVER_MULTIPART_LIMITS,
  COVER_UPLOAD_FIELD,
} from '@eventflow/event-contracts';
import { UserGuard, type UserRequest } from '../user.guard';
import { resourceId } from '../organizations/organization.controller';
import { CoverService, type ImageUpload } from './cover.service';

@Controller('api/v1/organizations/:id/events/:eventId/cover')
@UseGuards(UserGuard)
export class CoverController {
  constructor(@Inject(CoverService) private readonly covers: CoverService) {}
  @Post()
  @UseInterceptors(FileInterceptor(COVER_UPLOAD_FIELD, { limits: COVER_MULTIPART_LIMITS }))
  upload(
    @Req() req: UserRequest,
    @Param('id') id: string,
    @Param('eventId') eventId: string,
    @UploadedFile() file: ImageUpload | undefined,
  ) {
    return this.covers.upload(req.actor, resourceId(id), resourceId(eventId), file);
  }
  @Get() async preview(
    @Req() req: UserRequest,
    @Param('id') id: string,
    @Param('eventId') eventId: string,
    @Res() response: Response,
  ) {
    const result = await this.covers.preview(req.actor, resourceId(id), resourceId(eventId));
    response.setHeader('content-type', APPROVED_COVER_MIME_TYPE);
    response.setHeader('cache-control', 'private, no-store');
    response.send(result.body);
  }
}

@Controller('api/v1/covers')
export class PublicCoverController {
  constructor(@Inject(CoverService) private readonly covers: CoverService) {}
  @Get(':id') async get(@Param('id') id: string, @Res() response: Response) {
    const result = await this.covers.read(resourceId(id));
    response.setHeader('content-type', APPROVED_COVER_MIME_TYPE);
    response.setHeader('cache-control', 'public, max-age=31536000, immutable');
    response.setHeader('etag', `"${result.id}"`);
    response.send(result.body);
  }
}
