import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

export function configurePostgresPort(directory, port) {
  if (!/^\d+$/.test(String(port)) || Number(port) < 1024 || Number(port) > 65535)
    throw new Error('Choose a local PostgreSQL port between 1024 and 65535');
  const path = resolve(directory, '.env'),
    source = readFileSync(path, 'utf8'),
    env = parseEnv(source);
  const values = { POSTGRES_PORT: String(Number(port)) };
  for (const service of ['CATALOG', 'BOOKING', 'PAYMENTS', 'TICKETS', 'ANALYTICS']) {
    const key = `${service}_DATABASE_URL`,
      url = new URL(env[key]);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hostname !== '127.0.0.1')
      throw new Error('Port configuration is restricted to local service databases');
    url.port = values.POSTGRES_PORT;
    values[key] = url.href;
  }
  const retained = source
    .split(/\r?\n/)
    .filter((line) => !Object.keys(values).some((key) => line.startsWith(key + '=')))
    .join('\n')
    .trimEnd();
  writeFileSync(
    path,
    retained +
      '\n' +
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n') +
      '\n',
    { mode: 0o600 },
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Use env:postgres-port PORT');
  configurePostgresPort(process.cwd(), process.argv[2]);
  console.log(
    'Local PostgreSQL port updated. Run infra:up to apply it; data volumes are preserved.',
  );
}
