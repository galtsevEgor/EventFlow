import { Body, Controller, Get, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { parseInput } from '@eventflow/service-runtime';
import { UserGuard, type UserRequest } from '../user.guard';
import { OrganizationService } from './organization.service';

const organizationInput = z.strictObject({ name: z.string().trim().min(2).max(100) });
export const resourceId = (value: string) => parseInput(z.uuid(), value);

@Controller('api/v1/organizations')
@UseGuards(UserGuard)
export class OrganizationController {
  constructor(@Inject(OrganizationService) private readonly organizations: OrganizationService) {}
  @Get() list(@Req() request: UserRequest) {
    return this.organizations.list(request.actor);
  }
  @Post() create(@Req() request: UserRequest, @Body() body: unknown) {
    return this.organizations.create(request.actor, parseInput(organizationInput, body).name);
  }
  @Get(':id') get(@Req() request: UserRequest, @Param('id') id: string) {
    return this.organizations.get(request.actor, resourceId(id));
  }
  @Patch(':id') rename(
    @Req() request: UserRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.organizations.rename(
      request.actor,
      resourceId(id),
      parseInput(organizationInput, body).name,
    );
  }
  @Get(':id/audit') audit(@Req() request: UserRequest, @Param('id') id: string) {
    return this.organizations.audit(request.actor, resourceId(id));
  }
}
