/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core';
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
  type PrecacheEntry,
} from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: (PrecacheEntry | string)[] };
// The navigation handler is limited to the gate. Private APIs always use the network.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/organizer/index.html'), {
    allowlist: [/^\/organizer\/gate(?:\/|$)/],
  }),
);
clientsClaim();
self.addEventListener('message', (event) => {
  if (event.data?.type === 'ACTIVATE_UPDATE') void self.skipWaiting();
});
