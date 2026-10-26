import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  type KeyObject,
} from 'node:crypto';
import { ApiError } from '@eventflow/service-runtime';
import {
  offlineManifestSchema,
  type AdmissionWindow,
  type OfflineSync,
} from '@eventflow/event-contracts';
import type { Database } from './database';
import { CheckInTicket } from './check-in';

export class OfflineCheckIn {
  private readonly key?: KeyObject;
  private readonly publicKey?: { id: string; jwk: { kty: 'OKP'; crv: 'Ed25519'; x: string } };
  constructor(
    private readonly db: Database,
    seed?: string,
  ) {
    if (seed) {
      if (!/^[a-fA-F0-9]{64}$/.test(seed)) throw new Error('Invalid offline signing key');
      this.key = createPrivateKey({
        key: Buffer.from(`302e020100300506032b657004220420${seed}`, 'hex'),
        format: 'der',
        type: 'pkcs8',
      });
      const jwk = createPublicKey(this.key).export({ format: 'jwk' });
      const x = jwk.x!;
      this.publicKey = {
        id: createHash('sha256').update(Buffer.from(x, 'base64url')).digest('hex'),
        jwk: { kty: 'OKP', crv: 'Ed25519', x },
      };
    }
  }
  keys() {
    this.available();
    return { keys: [this.publicKey!] };
  }
  private available() {
    if (!this.key) throw new ApiError(503, 'OFFLINE_UNAVAILABLE', 'Автономный допуск недоступен.');
  }
  async prepare(
    actorSubject: string,
    input: { deviceId: string; organizationId: string; eventId: string },
    window: AdmissionWindow,
  ) {
    this.available();
    const manifest = await this.db.$transaction(async (tx) => {
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (!clock) throw new Error('Database clock unavailable');
      const end = new Date(window.admissionEndsAt);
      if (clock.now >= end || +new Date(window.admissionStartsAt) - +clock.now > 86400000)
        throw new ApiError(
          409,
          'OFFLINE_WINDOW_CLOSED',
          'Подготовка автономного допуска недоступна.',
        );
      const tickets = await tx.$queryRaw<{ qrHash: string }[]>`
        SELECT t."qrHash" FROM "Ticket" t LEFT JOIN "RefundGate" r ON r."orderId" = t."orderId"
        WHERE t."organizationId" = ${input.organizationId}::uuid AND t."saleId" = ${input.eventId}::uuid
          AND t."usedAt" IS NULL AND (r.state IS NULL OR r.state NOT IN ('LOCKED','REVOKED'))
        ORDER BY t."qrHash" LIMIT 10001`;
      if (tickets.length > 10000)
        throw new ApiError(
          409,
          'OFFLINE_SNAPSHOT_TOO_LARGE',
          'Слишком много билетов для автономного допуска.',
        );
      const manifest = offlineManifestSchema.parse({
        version: 1,
        sessionId: randomUUID(),
        ...input,
        actorSubject,
        issuedAt: clock.now.toISOString(),
        expiresAt: new Date(Math.min(+clock.now + 1800000, +end)).toISOString(),
        ...window,
        hashes: tickets.map((t) => t.qrHash),
      });
      await tx.offlineSession.create({
        data: {
          id: manifest.sessionId,
          ...input,
          actorSubject,
          issuedAt: new Date(manifest.issuedAt),
          expiresAt: new Date(manifest.expiresAt),
          hashes: manifest.hashes,
        },
      });
      return manifest;
    });
    const payload = JSON.stringify(manifest);
    return {
      payload,
      signature: sign(null, Buffer.from(payload), this.key!).toString('base64url'),
      keyId: this.publicKey!.id,
    };
  }
  async session(actorSubject: string, sessionId: string, deviceId: string) {
    this.available();
    const session = await this.db.offlineSession.findUnique({ where: { id: sessionId } });
    if (!session || session.actorSubject !== actorSubject || session.deviceId !== deviceId)
      throw new ApiError(403, 'FORBIDDEN', 'Сессия недоступна.');
    return session;
  }
  async sync(actorSubject: string, input: OfflineSync, window: AdmissionWindow) {
    const session = await this.session(actorSubject, input.sessionId, input.deviceId);
    const scan = new CheckInTicket(this.db);
    const results = [];
    for (const operation of input.operations) {
      const outcome = await scan.run(
        actorSubject,
        { ...operation, organizationId: session.organizationId, eventId: session.eventId },
        window,
        { sessionId: session.id, deviceId: input.deviceId, capturedAt: operation.capturedAt },
      );
      results.push({
        requestId: operation.requestId,
        result: outcome.result,
        admittedAt: outcome.admittedAt?.toISOString() ?? null,
        reason: outcome.reason ?? null,
      });
    }
    return { results };
  }
}
