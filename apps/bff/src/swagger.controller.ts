import { dirname, join } from 'node:path';
import { Controller, Get, Header, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response } from 'express';

const bffRoot = join(__dirname, '..');
const assets = join(bffRoot, 'assets');
const vendorAssets = dirname(require.resolve('swagger-ui-dist/swagger-ui-bundle.js'));
const assetRoots = new Map([
  ['swagger-ui.css', vendorAssets],
  ['swagger-ui-bundle.js', vendorAssets],
  ['swagger-initializer.js', assets],
]);
const pagePolicy = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

@Controller('api/v1')
export class SwaggerController {
  @Get('docs')
  @Header('Content-Security-Policy', pagePolicy)
  @Header('Cache-Control', 'no-cache')
  docs(@Res() response: Response) {
    return response.sendFile('swagger.html', { root: assets });
  }

  @Get('openapi.json')
  @Header('Cache-Control', 'no-cache')
  openapi(@Res() response: Response) {
    return response.sendFile('openapi.json', { root: bffRoot });
  }

  @Get('docs/:asset')
  @Header('Cache-Control', 'no-cache')
  asset(@Param('asset') name: string, @Res() response: Response) {
    const root = assetRoots.get(name);
    if (!root) throw new NotFoundException();
    return response.sendFile(name, { root });
  }
}
