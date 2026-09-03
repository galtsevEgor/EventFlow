import { z } from 'zod';

const portSchema = z.coerce.number().int().min(1).max(65535);
const hostSchema = z.string().trim().min(1);

export function readServiceConfig(
  environment: NodeJS.ProcessEnv,
  defaults: { name: string; port: number },
) {
  return {
    name: defaults.name,
    port: portSchema.parse(environment['PORT'] ?? defaults.port),
    host: hostSchema.parse(environment['HOST'] ?? '127.0.0.1'),
  };
}

export type ServiceConfig = ReturnType<typeof readServiceConfig>;
