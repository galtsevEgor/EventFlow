import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  ...(process.env.PAYMENTS_DATABASE_URL
    ? { datasource: { url: process.env.PAYMENTS_DATABASE_URL } }
    : {}),
});
