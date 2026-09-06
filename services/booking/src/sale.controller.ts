import { Controller, Get, Inject, Param } from '@nestjs/common';
import { z } from 'zod';
import { parseInput } from '@eventflow/service-runtime';
import { SaleReader } from './sale-reader';

@Controller('api/v1/sales')
export class SaleController {
  constructor(@Inject(SaleReader) private readonly sales: SaleReader) {}
  @Get(':id') get(@Param('id') id: string) {
    return this.sales.read(parseInput(z.uuid(), id));
  }
}
