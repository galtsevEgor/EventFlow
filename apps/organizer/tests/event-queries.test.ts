import { afterEach, expect, test } from 'vitest';
import { queryClient } from '../src/api';
import { eventListOptions, invalidateEventList } from '../src/event-queries';

afterEach(() => queryClient.clear());

test('event list updates invalidate only the owning organization', async () => {
  const first = eventListOptions('first').queryKey;
  const second = eventListOptions('second').queryKey;
  const firstList = { events: [] };
  const secondList = { events: [] };
  queryClient.setQueryData(first, firstList);
  queryClient.setQueryData(second, secondList);

  await invalidateEventList('first');

  expect(queryClient.getQueryState(first)?.isInvalidated).toBe(true);
  expect(queryClient.getQueryState(second)?.isInvalidated).toBe(false);
  expect(queryClient.getQueryData(first)).toBe(firstList);
  expect(queryClient.getQueryData(second)).toBe(secondList);
});
