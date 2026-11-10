import { z } from 'zod';
import { localServiceHost } from './local-services';

export const DEFAULT_MESSAGE_NAMESPACE = 'eventflow';
export const messageNamespaceSchema = z
  .string()
  .regex(/^[a-z0-9-]{1,80}$/)
  .default(DEFAULT_MESSAGE_NAMESPACE);

const portSchema = z.coerce.number().int().min(1).max(65535);
const hostSchema = z.string().trim().min(1);

export function readServiceConfig(
  environment: NodeJS.ProcessEnv,
  defaults: { name: string; port: number },
) {
  return {
    name: defaults.name,
    port: portSchema.parse(environment['PORT'] ?? defaults.port),
    host: hostSchema.parse(environment['HOST'] ?? localServiceHost),
  };
}

export type ServiceConfig = ReturnType<typeof readServiceConfig>;
