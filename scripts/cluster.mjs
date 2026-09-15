import { check, kubectl, up } from './cluster/local.mjs';

const [command, releaseId, ...extra] = process.argv.slice(2);
if (!extra.length && command === 'up' && releaseId) await up(releaseId);
else if (command === 'check' && !releaseId) check();
else if (command === 'status' && !releaseId) kubectl(['get', 'pods,jobs,svc']);
else throw new Error('Use pnpm cluster up RELEASE_ID | check | status.');
