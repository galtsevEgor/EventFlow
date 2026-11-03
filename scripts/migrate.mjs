import { execFileSync } from 'node:child_process';
import { migrateAnalytics } from './analytics-database.mjs';
import { migrateWaitlist } from './waitlist-database.mjs';
if (process.env.RECOMMENDATIONS_ENABLED === 'true')
  execFileSync(process.execPath, ['scripts/recommendations.mjs', 'migrate'], {
    stdio: 'inherit',
    windowsHide: true,
    env: process.env,
  });
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
