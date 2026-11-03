import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import pg from 'pg';

test('recommendations owns an isolated pgvector database and a non-superuser can rank vectors', async () => {
  const client = new pg.Client({ connectionString: process.env.RECOMMENDATIONS_DATABASE_URL });
  await client.connect();
  try {
    const role = await client.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user');
    assert.equal(role.rows[0].rolsuper, false);
    const extension = await client.query(
      "SELECT extversion FROM pg_extension WHERE extname='vector'",
    );
    assert.equal(extension.rows[0].extversion, '0.8.7');
    assert.notEqual(
      new URL(process.env.RECOMMENDATIONS_DATABASE_URL).port,
      new URL(process.env.CATALOG_DATABASE_URL).port,
    );
    const table = 'vector_probe_' + randomUUID().replaceAll('-', '');
    await client.query('BEGIN');
    await client.query('CREATE TABLE "' + table + '" (id text PRIMARY KEY, embedding vector(3))');
    await client.query('INSERT INTO "' + table + '" VALUES ($1,$2::vector),($3,$4::vector)', [
      'jazz',
      '[1,0,0]',
      'theatre',
      '[0,1,0]',
    ]);
    await client.query('CREATE INDEX ON "' + table + '" USING hnsw (embedding vector_cosine_ops)');
    const result = await client.query(
      'SELECT id,embedding <=> $1::vector AS distance FROM "' +
        table +
        '" ORDER BY embedding <=> $1::vector,id',
      ['[1,0,0]'],
    );
    assert.equal(result.rows[0].id, 'jazz');
    assert.equal(result.rows[0].distance, 0);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
