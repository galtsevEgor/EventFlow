import { z } from 'zod';

export const workloadConfig = {
  EVENTFLOW_WORKLOAD: z.enum(['combined', 'http', 'worker']).default('combined'),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).max(32).optional(),
};
