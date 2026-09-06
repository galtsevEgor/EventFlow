import { readFileSync, writeFileSync } from 'node:fs';
import openapiTS, { astToString } from 'openapi-typescript';
import prettier from 'prettier';
import ts from 'typescript';

const catalog = JSON.parse(readFileSync('services/catalog/openapi.json', 'utf8'));
const booking = JSON.parse(readFileSync('services/booking/openapi.json', 'utf8'));
const auth = JSON.parse(readFileSync('apps/bff/auth.openapi.json', 'utf8'));
const schema = {
  openapi: '3.1.0',
  info: { title: 'EventFlow public API', version: '1.0.0' },
  paths: {
    ...Object.fromEntries(
      Object.entries(catalog.paths).filter(([path]) => path.startsWith('/api/v1/')),
    ),
    ...Object.fromEntries(
      Object.entries(booking.paths).filter(([path]) => path.startsWith('/api/v1/')),
    ),
    ...auth.paths,
  },
  components: {
    schemas: {
      ...catalog.components.schemas,
      ...booking.components.schemas,
      ...auth.components.schemas,
    },
    securitySchemes: { session: { type: 'apiKey', in: 'cookie', name: 'eventflow_session' } },
  },
  security: [{ session: [] }],
};
const format = await prettier.resolveConfig('package.json');
const files = {
  'apps/bff/openapi.json': await prettier.format(JSON.stringify(schema), {
    ...format,
    parser: 'json',
  }),
  'packages/api-client/src/schema.ts': await prettier.format(
    astToString(
      await openapiTS(schema, {
        transform(node) {
          if (node.format === 'binary') return ts.factory.createTypeReferenceNode('Blob');
        },
      }),
    ),
    {
      ...format,
      parser: 'typescript',
    },
  ),
};
for (const [path, content] of Object.entries(files)) {
  if (process.argv.includes('--check')) {
    if (readFileSync(path, 'utf8') !== content)
      throw new Error(`API contract is stale: ${path}. Run pnpm api:generate.`);
  } else writeFileSync(path, content);
}
console.log(
  process.argv.includes('--check')
    ? 'Generated API contracts match their sources.'
    : 'Public API contract and typed client schema generated.',
);
