import { randomUUID } from 'node:crypto';
import { ApiError, type UserIdentity } from '@eventflow/service-runtime';
import { Database } from '../database';
import { lockOrganization, requireMembership } from '../organizations/access';
import { DraftService } from '../events/draft.service';
import { approveImage } from './image';
import { CoverStorage } from './storage';

export type ImageUpload = { buffer: Buffer; mimetype: string; size: number };
export class CoverService {
  constructor(
    private readonly db: Database,
    private readonly storage: CoverStorage | null,
    private readonly drafts: DraftService,
  ) {}
  async upload(
    actor: UserIdentity,
    organizationId: string,
    eventId: string,
    file: ImageUpload | undefined,
  ) {
    if (!file) throw new ApiError(422, 'FILE_REQUIRED', 'Выберите файл афиши.');
    await requireMembership(this.db, actor, organizationId, ['OWNER', 'MANAGER']);
    await this.drafts.get(actor, organizationId, eventId);
    if (!this.storage)
      throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Хранилище афиш не настроено.');
    const id = randomUUID(),
      privateKey = `private/${id}`,
      approvedKey = `approved/${id}.webp`;
    let storedApproved = false,
      committed = false;
    try {
      await this.storage.put(privateKey, file.buffer, 'application/octet-stream');
      const approved = await approveImage(file.buffer, file.mimetype);
      await this.storage.put(approvedKey, approved.body, 'image/webp');
      storedApproved = true;
      const result = await this.db.$transaction(async (tx) => {
        await lockOrganization(tx, organizationId);
        await requireMembership(tx, actor, organizationId, ['OWNER', 'MANAGER']);
        const event = await tx.eventDraft.findFirst({ where: { id: eventId, organizationId } });
        if (!event) throw new ApiError(404, 'NOT_FOUND', 'Мероприятие не найдено.');
        await tx.coverAsset.create({
          data: {
            id,
            eventId,
            objectKey: approvedKey,
            width: approved.width,
            height: approved.height,
            bytes: approved.body.length,
          },
        });
        const updated = await tx.eventDraft.update({
          where: { id: eventId },
          data: { coverId: id, revision: { increment: 1 } },
        });
        await tx.auditEntry.create({
          data: {
            organizationId,
            actorSubject: actor.subject,
            action: 'cover.approved',
            targetId: eventId,
            details: { assetId: id },
          },
        });
        return updated;
      });
      committed = true;
      return result;
    } finally {
      const cleanup = [this.storage.remove(privateKey)];
      if (storedApproved && !committed) cleanup.push(this.storage.remove(approvedKey));
      const results = await Promise.allSettled(cleanup);
      if (results.some((result) => result.status === 'rejected'))
        console.warn(JSON.stringify({ kind: 'cover_cleanup_failed', assetId: id }));
    }
  }
  async preview(actor: UserIdentity, organizationId: string, eventId: string) {
    const event = await this.drafts.get(actor, organizationId, eventId);
    if (!event.coverId) throw new ApiError(404, 'NOT_FOUND', 'Афиша не загружена.');
    return this.read(event.coverId, false);
  }
  async read(id: string, publicOnly = true) {
    const asset = await this.db.coverAsset.findFirst({
      where: { id, ...(publicOnly ? { isPublic: true } : {}) },
    });
    if (!asset) throw new ApiError(404, 'NOT_FOUND', 'Афиша не найдена.');
    if (!this.storage)
      throw new ApiError(503, 'STORAGE_UNAVAILABLE', 'Хранилище афиш не настроено.');
    return { body: await this.storage.get(asset.objectKey), id: asset.id };
  }
}
