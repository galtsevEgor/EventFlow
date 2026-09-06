import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { parseInput } from '@eventflow/service-runtime';
import { UserGuard, type UserRequest } from '../user.guard';
import { resourceId } from '../organizations/organization.controller';
import { DraftService } from './draft.service';

const draftInput = z.strictObject({
  title: z.string().trim().min(2).max(160),
  description: z.string().trim().max(5000).default(''),
});
@Controller('api/v1/organizations/:id/events')
@UseGuards(UserGuard)
export class DraftController {
  constructor(@Inject(DraftService) private readonly drafts: DraftService) {}
  @Put(':eventId/configuration') configure(
    @Req() req: UserRequest,
    @Param('id') id: string,
    @Param('eventId') eventId: string,
    @Body() body: unknown,
  ) {
    const input = parseInput(
      z.strictObject({ revision: z.number().int().nonnegative(), configuration: z.unknown() }),
      body,
    );
    return this.drafts.configure(
      req.actor,
      resourceId(id),
      resourceId(eventId),
      input.revision,
      input.configuration,
    );
  }
  @Get() list(@Req() req: UserRequest, @Param('id') id: string) {
    return this.drafts.list(req.actor, resourceId(id));
  }
  @Get(':eventId') get(
    @Req() req: UserRequest,
    @Param('id') id: string,
    @Param('eventId') eventId: string,
  ) {
    return this.drafts.get(req.actor, resourceId(id), resourceId(eventId));
  }
  @Post() create(@Req() req: UserRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.drafts.save(req.actor, resourceId(id), parseInput(draftInput, body));
  }
  @Patch(':eventId') update(
    @Req() req: UserRequest,
    @Param('id') id: string,
    @Param('eventId') eventId: string,
    @Body() body: unknown,
  ) {
    return this.drafts.save(
      req.actor,
      resourceId(id),
      parseInput(draftInput, body),
      resourceId(eventId),
    );
  }
}
