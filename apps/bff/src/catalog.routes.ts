const uuid = '[0-9a-fA-F-]{36}';
const member = '[A-Za-z0-9_:-]{1,128}';
const org = `/api/v1/organizations/${uuid}`;
const routes: [string[], RegExp][] = [
  [['GET', 'POST'], /^\/api\/v1\/organizations$/],
  [['GET', 'PATCH'], new RegExp(`^${org}$`)],
  [['GET'], new RegExp(`^${org}/(?:audit|members)$`)],
  [['GET'], new RegExp(`^${org}/statistics$`)],
  [['PATCH', 'DELETE'], new RegExp(`^${org}/members/${member}$`)],
  [['PUT'], new RegExp(`^${org}/members/${member}/events/${uuid}$`)],
  [['GET', 'POST'], new RegExp(`^${org}/invitations$`)],
  [['DELETE'], new RegExp(`^${org}/invitations/${uuid}$`)],
  [['POST'], /^\/api\/v1\/invitations\/accept$/],
  [['GET', 'POST'], new RegExp(`^${org}/events$`)],
  [['GET', 'PATCH'], new RegExp(`^${org}/events/${uuid}$`)],
  [['PUT'], new RegExp(`^${org}/events/${uuid}/configuration$`)],
  [['GET', 'POST'], new RegExp(`^${org}/events/${uuid}/cover$`)],
  [['GET'], new RegExp(`^/api/v1/covers/${uuid}$`)],
  [['POST'], new RegExp(`^${org}/events/${uuid}/publication$`)],
  [['POST'], new RegExp(`^${org}/events/${uuid}/publication/retry$`)],
  [['PUT'], new RegExp(`^${org}/events/${uuid}/availability$`)],
  [['GET'], /^\/api\/v1\/events$/],
  [['GET'], new RegExp(`^/api/v1/events/${uuid}$`)],
];
export function isCatalogRoute(method: string, path: string) {
  return routes.some(([methods, pattern]) => methods.includes(method) && pattern.test(path));
}
