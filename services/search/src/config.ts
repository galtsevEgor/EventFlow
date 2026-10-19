import { z } from 'zod';
export function readSearchConfig(env: NodeJS.ProcessEnv) {
  return z
    .object({
      OPENSEARCH_URL: z
        .url()
        .refine((value) => {
          const url = new URL(value);
          return (
            url.protocol === 'http:' &&
            ['127.0.0.1', 'localhost', 'opensearch'].includes(url.hostname) &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            url.pathname === '/'
          );
        })
        .default('http://127.0.0.1:19200'),
      SEARCH_INDEX_NAMESPACE: z
        .string()
        .regex(/^eventflow-[a-z0-9-]{1,80}$/)
        .default('eventflow-search'),
    })
    .parse(env);
}
export type SearchConfig = ReturnType<typeof readSearchConfig>;
