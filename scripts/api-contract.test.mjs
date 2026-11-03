import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('public OpenAPI uses declared browser authentication and leaves public recommendations anonymous', () => {
  const schema = JSON.parse(readFileSync('apps/bff/openapi.json', 'utf8'));
  const declared = Object.keys(schema.components.securitySchemes);
  for (const path of Object.values(schema.paths)) {
    for (const operation of Object.values(path)) {
      for (const requirement of operation.security ?? schema.security) {
        assert.ok(Object.keys(requirement).every((name) => declared.includes(name)));
      }
    }
  }
  assert.deepEqual(schema.paths['/api/v1/recommendations/profile'].get.security, [{ session: [] }]);
  assert.deepEqual(schema.paths['/api/v1/recommendations/interests'].get.security, []);
  assert.deepEqual(schema.paths['/api/v1/events/{id}/similar'].get.security, []);
  assert.deepEqual(schema.paths['/api/v1/recommendations/me'].get.security, [{ session: [] }]);
});
