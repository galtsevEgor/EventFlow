import createClient from 'openapi-fetch';
import { z } from 'zod';
import type { paths, components } from './schema';

export type Schemas = components['schemas'];
export type { paths } from './schema';

export const sessionSchema = z.union([
  z.strictObject({ user: z.null() }),
  z.strictObject({
    user: z.strictObject({
      sub: z.string(),
      email: z.email(),
      emailVerified: z.boolean(),
      name: z.string(),
    }),
    csrfToken: z.string().min(1),
  }),
]) satisfies z.ZodType<Schemas['Session']>;

export function createApiClient(baseUrl = '') {
  let csrfToken = '';
  const client = createClient<paths>({ baseUrl, credentials: 'same-origin' });
  client.use({
    onRequest({ request }) {
      if (!['GET', 'HEAD'].includes(request.method)) request.headers.set('x-csrf-token', csrfToken);
      return request;
    },
  });
  return {
    client,
    async getSession() {
      return sessionSchema.parse(unwrap(await client.GET('/api/v1/auth/session')));
    },
    setCsrfToken(value: string) {
      csrfToken = value;
    },
  };
}

export class ApiRequestError extends Error {
  constructor(readonly problem: Schemas['ApiError']) {
    super(problem.message);
  }
}
export function unwrap<T>(result: { data?: T; error?: Schemas['ApiError'] }): T {
  if (result.error) throw new ApiRequestError(result.error);
  if (result.data === undefined) throw new Error('Сервер вернул пустой ответ.');
  return result.data;
}
