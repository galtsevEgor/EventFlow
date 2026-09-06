import { ApiError } from '@eventflow/service-runtime';
import type { Database } from '../database';
import { InvalidWebhook, type PaymentProvider } from '../providers/provider';

export class ReceiveWebhook {
  constructor(
    private readonly db: Database,
    private readonly provider: PaymentProvider,
  ) {}
  async run(raw: Buffer | undefined, signature: string | undefined) {
    if (!raw || this.provider.name !== 'stripe')
      throw new ApiError(400, 'INVALID_WEBHOOK', 'Недействительное уведомление.');
    let pointer;
    try {
      pointer = this.provider.verifyWebhook(raw, signature);
    } catch (error) {
      if (error instanceof InvalidWebhook)
        throw new ApiError(400, 'INVALID_WEBHOOK', 'Недействительное уведомление.');
      throw error;
    }
    await this.db.$executeRaw`INSERT INTO "ProviderWebhook" ("eventId", "objectId", type)
      VALUES (${pointer.eventId}, ${pointer.objectId}, ${pointer.type}) ON CONFLICT ("eventId") DO NOTHING`;
    const saved = await this.db.providerWebhook.findUniqueOrThrow({
      where: { eventId: pointer.eventId },
    });
    if (saved.objectId !== pointer.objectId || saved.type !== pointer.type)
      throw new ApiError(400, 'INVALID_WEBHOOK', 'Недействительное уведомление.');
    // Store only verified routing data. Card data and client secrets never enter the inbox.
    return { received: true };
  }
}
