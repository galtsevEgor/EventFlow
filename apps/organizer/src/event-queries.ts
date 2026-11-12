import { queryOptions } from '@tanstack/react-query';
import { api, queryClient, unwrap } from './api';

const PUBLICATION_POLL_INTERVAL_MS = 1_000;

const eventListKey = (organizationId: string) => ['events', organizationId] as const;

export function eventListOptions(organizationId: string) {
  return queryOptions({
    queryKey: eventListKey(organizationId),
    queryFn: async ({ signal }) =>
      unwrap(
        await api.client.GET('/api/v1/organizations/{id}/events', {
          params: { path: { id: organizationId } },
          signal,
        }),
      ),
    refetchInterval: ({ state }) =>
      state.data?.events.some(({ publication }) =>
        publication
          ? publication.state === 'PROVISIONING' ||
            publication.commandVersion > publication.acknowledgedVersion
          : false,
      )
        ? PUBLICATION_POLL_INTERVAL_MS
        : false,
  });
}

export function invalidateEventList(organizationId: string) {
  return queryClient.invalidateQueries({ queryKey: eventListKey(organizationId), exact: true });
}
