import { execFileSync } from 'node:child_process';
for (const service of ['catalog', 'booking', 'payments']) {
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
