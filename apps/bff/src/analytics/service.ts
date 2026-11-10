import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Request, Response } from 'express';
import { ClientCredentials, ApiError } from '@eventflow/service-runtime';
import { MAX_SEARCH_PAGE_SIZE, type SearchPage } from '@eventflow/event-contracts';
import type { AuthConfig } from '../auth/config';
import { AnalyticsSession } from './session';

const SEARCH_PROOF_TTL_MS = 24 * 60 * 60 * 1_000;
const proofSchema = z.strictObject({
  id: z.uuid(),
  events: z.array(z.uuid()).max(MAX_SEARCH_PAGE_SIZE),
  expires: z.number(),
});
export class AnalyticsBridge {
  readonly session: AnalyticsSession;
  private readonly credentials: ClientCredentials;
  private pending = 0;
  private readonly jobs = new Set<Promise<unknown>>();
  constructor(readonly config: AuthConfig) {
    this.session = new AnalyticsSession(config.ANALYTICS_SESSION_KEY ?? config.OIDC_CLIENT_SECRET);
    this.credentials = new ClientCredentials(
      config.OIDC_ISSUER,
      'eventflow-analytics',
      config.ANALYTICS_CLIENT_SECRET ?? config.OIDC_CLIENT_SECRET,
    );
  }
  get enabled() {
    return this.config.ANALYTICS_ENABLED === 'true';
  }
  async send(path: string, body: unknown) {
    if (!this.enabled) throw new ApiError(503, 'ANALYTICS_DISABLED', 'Аналитика отключена.');
    const response = await fetch(
      new URL('/internal/analytics/' + path, this.config.ANALYTICS_URL),
      {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(3000),
        headers: {
          authorization: 'Bearer ' + (await this.credentials.token()),
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new ApiError(
        response.status >= 500 ? 503 : response.status,
        'ANALYTICS_UNAVAILABLE',
        'Не удалось записать аналитику.',
      );
    }
    return response.json();
  }
  search(page: SearchPage) {
    if (!this.enabled) return page;
    const id = randomUUID(),
      searchProof = this.session.sign({
        id,
        events: page.events.map((e) => e.id),
        expires: Date.now() + SEARCH_PROOF_TTL_MS,
      });
    // Bounded, best-effort collection cannot delay discovery or accumulate an unbounded promise queue.
    if (this.pending < 20) {
      this.pending++;
      const job = this.send('search', {
        key: 'search:' + id,
        kind: 'search',
        organizationId: null,
        eventId: null,
        sessionId: null,
        orderId: null,
        searchId: id,
        occurredAt: new Date().toISOString(),
        source: 'search',
        resultCount: Math.min(page.total, 1000000),
        limited: page.limited,
      })
        .catch(() => {})
        .finally(() => {
          this.pending--;
          this.jobs.delete(job);
        });
      this.jobs.add(job);
    }
    return { ...page, searchProof };
  }
  searchId(proof: string | undefined, eventId: string) {
    const result = proofSchema.safeParse(proof ? this.session.verify(proof) : null);
    if (
      !result.success ||
      result.data.expires < Date.now() ||
      !result.data.events.includes(eventId)
    )
      return null;
    return result.data.id;
  }
  context(request: Request, response: Response) {
    if (this.enabled) this.session.ensure(request, response);
    return { enabled: this.enabled, serverTime: Date.now() };
  }
  async onModuleDestroy() {
    await Promise.allSettled([...this.jobs]);
  }
}
