import createClient from 'openapi-fetch';
import type { paths, components } from './schema';

export type Schemas = components['schemas'];
export type { paths } from './schema';

export function createApiClient() {
  let csrfToken = '';
  const client = createClient<paths>({ baseUrl: '', credentials: 'same-origin' });
  client.use({
    onRequest({ request }) {
      if (!['GET', 'HEAD'].includes(request.method)) request.headers.set('x-csrf-token', csrfToken);
      return request;
    },
  });
  return {
    client,
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
