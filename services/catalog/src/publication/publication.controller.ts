import { Body, Controller, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { parseInput } from '@eventflow/service-runtime';
import { UserGuard, type UserRequest } from '../user.guard';
import { resourceId } from '../organizations/organization.controller';
import { PublicationService } from './publication.service';

@Controller('api/v1/organizations/:id/events/:eventId/publication')
@UseGuards(UserGuard)
export class PublicationController {
  constructor(@Inject(PublicationService) private readonly publications: PublicationService) {}
  @Post() publish(
    @Req() req: UserRequest,
    @Param('id') id: string,
    @Param('eventId') eventId: string,
    @Body() body: unknown,
  ) {
    const input = parseInput(z.strictObject({ revision: z.number().int().nonnegative() }), body);
    return this.publications.publish(
      req.actor,
      resourceId(id),
      resourceId(eventId),
      input.revision,
    );
  }
}
