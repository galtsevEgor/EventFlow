import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function assertSuccessfulJobs(needs) {
  for (const name of ['quality', 'integration']) {
    if (needs?.[name]?.result !== 'success')
      throw new Error(`Required job ${name}: ${needs?.[name]?.result ?? 'missing'}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assertSuccessfulJobs(JSON.parse(process.env.NEEDS_JSON ?? '{}'));
  console.log('All required CI jobs passed.');
}
