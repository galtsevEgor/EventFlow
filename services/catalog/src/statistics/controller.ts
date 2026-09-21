import { Controller, Get, Inject, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { UserGuard, type UserRequest } from '../user.guard';
import { resourceId } from '../organizations/organization.controller';
import { StatisticsReport } from './report';

@Controller('api/v1/organizations/:id/statistics')
@UseGuards(UserGuard)
export class StatisticsController {
  constructor(@Inject(StatisticsReport) private readonly report: StatisticsReport) {}

  @Get() async get(
    @Req() request: UserRequest,
    @Param('id') id: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.report.get(request.actor, resourceId(id), query);
    response.setHeader('cache-control', 'no-store');
    return result;
  }
}
