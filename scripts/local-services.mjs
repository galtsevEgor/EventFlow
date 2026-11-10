import localServices from '../packages/service-runtime/src/local-services.json' with { type: 'json' };

export const { host: localServiceHost, ports: localServicePorts } = localServices;

export function localServiceOrigin(service) {
  return `http://${localServiceHost}:${localServicePorts[service]}`;
}
