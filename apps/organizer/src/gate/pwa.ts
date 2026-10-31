export async function registerGateWorker(
  onUpdate: (registration: ServiceWorkerRegistration) => void,
) {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return undefined;
  const registration = await navigator.serviceWorker.register('/organizer/sw.js', {
    scope: '/organizer/gate/',
    type: 'module',
  });
  if (registration.waiting) onUpdate(registration);
  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    installing?.addEventListener('statechange', () => {
      if (
        installing.state === 'installed' &&
        navigator.serviceWorker.controller &&
        registration.waiting
      )
        onUpdate(registration);
    });
  });
  return registration;
}
