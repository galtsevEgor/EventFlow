import { useQuery } from '@tanstack/react-query';
import { api, unwrap } from '../api';

const OPERATOR_ACCESS_STALE_TIME_MS = 30_000;
const OPERATOR_ACCESS_POLL_INTERVAL_MS = 60_000;

export function useOperatorAccess(subject: string | undefined) {
  return useQuery({
    queryKey: ['ops-access', subject],
    enabled: Boolean(subject),
    retry: false,
    staleTime: OPERATOR_ACCESS_STALE_TIME_MS,
    refetchInterval: OPERATOR_ACCESS_POLL_INTERVAL_MS,
    queryFn: async () => {
      const result = await api.client.GET('/api/v1/ops/access');
      if (result.response.status === 403) return null;
      return unwrap(result);
    },
  });
}
