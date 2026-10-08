import { useQuery } from '@tanstack/react-query';
import { api, unwrap } from '../api';
export function useOperatorAccess(subject: string | undefined) {
  return useQuery({
    queryKey: ['ops-access', subject],
    enabled: Boolean(subject),
    retry: false,
    staleTime: 30000,
    refetchInterval: 60000,
    queryFn: async () => {
      const result = await api.client.GET('/api/v1/ops/access');
      if (result.response.status === 403) return null;
      return unwrap(result);
    },
  });
}
