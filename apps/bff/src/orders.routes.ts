export type OrderUpstream = 'BOOKING' | 'PAYMENTS' | 'TICKETS';

type OrderRoute = { service: OrderUpstream; reserve?: true; png?: true };

const id = '[a-f0-9-]{36}';
const orders = '/api/v1/orders';
const order = `${orders}/${id}`;
const ticket = `${order}/tickets/${id}`;
const routes: [method: 'GET' | 'POST', path: RegExp, route: OrderRoute][] = [
  ['GET', new RegExp(`^${orders}(?:/${id})?$`), { service: 'BOOKING' }],
  ['POST', new RegExp(`^${orders}$`), { service: 'BOOKING', reserve: true }],
  ['POST', new RegExp(`^${order}/cancel$`), { service: 'BOOKING' }],
  ['GET', new RegExp(`^${order}/payment-status$`), { service: 'PAYMENTS' }],
  ['POST', new RegExp(`^${order}/payment-attempt(?:/fake-confirm)?$`), { service: 'PAYMENTS' }],
  ['GET', new RegExp(`^${order}/tickets$`), { service: 'TICKETS' }],
  ['GET', new RegExp(`^${ticket}/code$`), { service: 'TICKETS' }],
  ['GET', new RegExp(`^${ticket}/qr$`), { service: 'TICKETS', png: true }],
];

export function orderRoute(method: string, path: string): OrderRoute | undefined {
  return routes.find(([verb, pattern]) => method === verb && pattern.test(path))?.[2];
}
