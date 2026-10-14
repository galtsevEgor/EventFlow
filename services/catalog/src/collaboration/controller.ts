import { Body, Controller, Get, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { parseInput } from '@eventflow/service-runtime';
import { draftUpdateSchema } from '@eventflow/collaboration';
import { UserGuard, type UserRequest } from '../user.guard';
import { resourceId } from '../organizations/organization.controller';
import { DraftDocumentService } from './document.service';

@Controller('internal/collaboration/:organizationId/:eventId')
@UseGuards(UserGuard)
export class DraftDocumentController {
  constructor(@Inject(DraftDocumentService) private readonly documents: DraftDocumentService) {}

  @Get() read(
    @Req() req: UserRequest,
    @Param('organizationId') organizationId: string,
    @Param('eventId') eventId: string,
  ) {
    return this.documents.run(req.actor, resourceId(organizationId), resourceId(eventId));
  }

  @Post() update(
    @Req() req: UserRequest,
    @Param('organizationId') organizationId: string,
    @Param('eventId') eventId: string,
    @Body() raw: unknown,
  ) {
    return this.documents.run(
      req.actor,
      resourceId(organizationId),
      resourceId(eventId),
      parseInput(draftUpdateSchema, raw),
    );
  }
}
