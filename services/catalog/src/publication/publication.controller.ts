import { Body, Controller, Inject, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { parseInput } from '@eventflow/service-runtime';
import { UserGuard, type UserRequest } from '../user.guard';
import { resourceId } from '../organizations/organization.controller';
import { PublicationService } from './publication.service';
import { AvailabilityService } from './availability.service';

@Controller('api/v1/organizations/:id/events/:eventId')
@UseGuards(UserGuard)
export class PublicationController {
  constructor(
    @Inject(PublicationService) private readonly publications: PublicationService,
    @Inject(AvailabilityService) private readonly availability: AvailabilityService,
  ) {}
  @Put('availability') change(
    @Req() req: UserRequest,
    @Param('id') id: string,
    @Param('eventId') eventId: string,
    @Body() body: unknown,
  ) {
    const input = parseInput(
      z.strictObject({ paused: z.boolean(), expectedVersion: z.number().int().nonnegative() }),
      body,
    );
    return this.availability.change(
      req.actor,
      resourceId(id),
      resourceId(eventId),
      input.paused,
      input.expectedVersion,
    );
  }
  @Post('publication') publish(
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
  @Post('publication/retry') retry(
    @Req() req: UserRequest,
    @Param('id') id: string,
    @Param('eventId') eventId: string,
    @Body() body: unknown,
  ) {
    const input = parseInput(
      z.strictObject({ expectedAttempt: z.number().int().positive() }),
      body,
    );
    const key = parseInput(z.uuid(), req.header('idempotency-key'));
    return this.publications.retry(
      req.actor,
      resourceId(id),
      resourceId(eventId),
      input.expectedAttempt,
      key,
    );
  }
}
