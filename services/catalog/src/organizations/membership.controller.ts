import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import { resourceId } from './organization.controller';
import { MembershipService } from './membership.service';
import { InvitationService } from './invitation.service';

const subject = (value: string) =>
  parseInput(
    z
      .string()
      .min(1)
      .max(128)
      .regex(/^[\w:-]+$/),
    value,
  );
const invitationInput = z.strictObject({
  email: z
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  role: z.enum(['MANAGER', 'STAFF']),
});

@Controller('api/v1')
@UseGuards(UserGuard)
export class MembershipController {
  constructor(
    @Inject(MembershipService) private readonly members: MembershipService,
    @Inject(InvitationService) private readonly invitations: InvitationService,
  ) {}
  @Get('organizations/:id/members') list(@Req() req: UserRequest, @Param('id') id: string) {
    return this.members.list(req.actor, resourceId(id));
  }
  @Patch('organizations/:id/members/:user') role(
    @Req() req: UserRequest,
    @Param('id') id: string,
    @Param('user') user: string,
    @Body() body: unknown,
  ) {
    const { role } = parseInput(
      z.strictObject({ role: z.enum(['OWNER', 'MANAGER', 'STAFF']) }),
      body,
    );
    return this.members.changeRole(req.actor, resourceId(id), subject(user), role);
  }
  @Delete('organizations/:id/members/:user') remove(
    @Req() req: UserRequest,
    @Param('id') id: string,
    @Param('user') user: string,
  ) {
    return this.members.changeRole(req.actor, resourceId(id), subject(user), null);
  }
  @Put('organizations/:id/members/:user/events/:eventId') assign(
    @Req() req: UserRequest,
    @Param('id') id: string,
    @Param('user') user: string,
    @Param('eventId') eventId: string,
    @Body() body: unknown,
  ) {
    return this.members.assignEvent(
      req.actor,
      resourceId(id),
      subject(user),
      resourceId(eventId),
      parseInput(z.strictObject({ assigned: z.boolean() }), body).assigned,
    );
  }
  @Get('organizations/:id/invitations') listInvitations(
    @Req() req: UserRequest,
    @Param('id') id: string,
  ) {
    return this.invitations.list(req.actor, resourceId(id));
  }
  @Post('organizations/:id/invitations') invite(
    @Req() req: UserRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const data = parseInput(invitationInput, body);
    return this.invitations.create(req.actor, resourceId(id), data.email, data.role);
  }
  @Delete('organizations/:id/invitations/:invitationId') revoke(
    @Req() req: UserRequest,
    @Param('id') id: string,
    @Param('invitationId') invitationId: string,
  ) {
    return this.invitations.revoke(req.actor, resourceId(id), resourceId(invitationId));
  }
  @Post('invitations/accept') @HttpCode(200) accept(
    @Req() req: UserRequest,
    @Body() body: unknown,
  ) {
    return this.invitations.accept(
      req.actor,
      parseInput(z.strictObject({ token: z.string().regex(/^[\w-]{43}$/) }), body).token,
    );
  }
}
