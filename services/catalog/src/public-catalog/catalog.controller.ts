import { Controller, Get, Inject, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PublicCatalog } from './catalog.service';
import { resourceId } from '../organizations/organization.controller';

@Controller('api/v1/events')
export class PublicCatalogController {
  constructor(@Inject(PublicCatalog) private readonly catalog: PublicCatalog) {}
  @Get() async list(@Query() query: unknown, @Res({ passthrough: true }) response: Response) {
    const result = await this.catalog.list(query);
    response.setHeader('cache-control', 'public, max-age=15, s-maxage=30');
    return result;
  }
  @Get(':id') async get(@Param('id') id: string, @Res({ passthrough: true }) response: Response) {
    const result = await this.catalog.get(resourceId(id));
    response.setHeader('cache-control', 'public, max-age=15, s-maxage=30');
    return result;
  }
}
