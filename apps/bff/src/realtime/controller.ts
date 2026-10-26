import { Controller, Get, Inject, Param, Query, Req, Res } from '@nestjs/common';
import { parseInput } from '@eventflow/service-runtime';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { RealtimeHub } from './hub';

const id = (value: string) => parseInput(z.uuid(), value).toLowerCase();
@Controller('api/v1')
export class UpdatesController {
  constructor(@Inject(RealtimeHub) private readonly hub: RealtimeHub) {}
  @Get('waitlist/:id/updates') async waitlist(
    @Param('id') value: string,
    @Query() query: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    parseInput(z.strictObject({}), query);
    await this.hub.open(request, response, { scope: 'waitlist', id: id(value) });
  }
  @Get('sales/:id/updates') async sale(
    @Param('id') value: string,
    @Query() query: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    parseInput(z.strictObject({}), query);
    await this.hub.open(request, response, { scope: 'sale', id: id(value) });
  }
  @Get('orders/:id/updates') async order(
    @Param('id') value: string,
    @Query() query: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    parseInput(z.strictObject({}), query);
    await this.hub.open(request, response, { scope: 'order', id: id(value) });
  }
  @Get('organizations/:organizationId/events/:eventId/orders/updates') async organizer(
    @Param('organizationId') organizationId: string,
    @Param('eventId') eventId: string,
    @Query() query: unknown,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    parseInput(z.strictObject({}), query);
    await this.hub.open(request, response, {
      scope: 'organizer-orders',
      id: id(eventId),
      organizationId: id(organizationId),
    });
  }
}
