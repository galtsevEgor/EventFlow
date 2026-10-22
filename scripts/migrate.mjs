import { execFileSync } from 'node:child_process';
import { migrateAnalytics } from './analytics-database.mjs';
await migrateAnalytics();
for (const service of ['catalog', 'booking', 'payments', 'tickets']) {
  execFileSync(
    process.execPath,
    [
      'node_modules/prisma/build/index.js',
      'migrate',
      'deploy',
      `--config=services/${service}/prisma.config.ts`,
    ],
    { stdio: 'inherit', windowsHide: true },
  );
}
