import { ApiError } from '@eventflow/service-runtime';

export function upstreamUrl(base: string, path: string, originalUrl: string) {
  const url = new URL(path, base);
  if (url.origin !== new URL(base).origin)
    throw new ApiError(404, 'NOT_FOUND', 'Маршрут не найден.');
  // Absolute-form HTTP targets may supply a query, never an upstream origin.
  url.search = new URL(originalUrl, 'http://request.invalid').search;
  return url;
}
