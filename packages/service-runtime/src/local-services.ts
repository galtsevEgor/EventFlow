import localServices from './local-services.json';

export const { host: localServiceHost, ports: localServicePorts } = localServices;

export function localServiceOrigin(service: keyof typeof localServicePorts) {
  return `http://${localServiceHost}:${localServicePorts[service]}`;
}
