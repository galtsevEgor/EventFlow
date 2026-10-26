import { execFileSync } from 'node:child_process';
import { migrateAnalytics } from './analytics-database.mjs';
import { migrateWaitlist } from './waitlist-database.mjs';
await migrateAnalytics();
await migrateWaitlist();
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
