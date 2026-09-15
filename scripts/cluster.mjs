import { check, kubectl, up } from './cluster/local.mjs';

const [command, releaseId, profile, ...extra] = process.argv.slice(2);
if (!extra.length && command === 'up' && releaseId) await up(releaseId, profile);
else if (command === 'check' && !releaseId) check();
else if (command === 'status' && !releaseId) kubectl(['get', 'pods,jobs,svc']);
else throw new Error('Use pnpm cluster up RELEASE_ID [single|replicas] | check | status.');
