import { randomUUID } from 'node:crypto';
import { ApiError, type UserIdentity } from '@eventflow/service-runtime';
import { initialDocument, readDocument, type DraftSnapshot } from '@eventflow/collaboration';
import { Database } from '../database';
import type { Prisma } from '../generated/client';
import { lockOrganization, requireMembership } from '../organizations/access';

export class DraftDocumentService {
  constructor(private readonly db: Database) {}

  private async access(
    tx: Prisma.TransactionClient,
    actor: UserIdentity,
    organizationId: string,
    eventId: string,
  ) {
    await lockOrganization(tx, organizationId);
    const member = await requireMembership(tx, actor, organizationId);
    const event = await tx.eventDraft.findFirst({
      where: {
        id: eventId,
        organizationId,
        ...(member.role === 'STAFF'
          ? { assignments: { some: { userSubject: actor.subject } } }
          : {}),
      },
      include: { publication: true, document: true },
    });
    if (!event) throw new ApiError(404, 'NOT_FOUND', 'Черновик не найден.');
    if (event.publication)
      throw new ApiError(
        409,
        'DRAFT_CLOSED',
        'Совместное редактирование завершено: публикация уже началась.',
      );
    return { event, canEdit: member.role !== 'STAFF' };
  }

  async run(
    actor: UserIdentity,
    organizationId: string,
    eventId: string,
    update?: { epoch: string; state: string },
  ): Promise<DraftSnapshot> {
    return this.db.$transaction(async (tx) => {
      const { event, canEdit } = await this.access(tx, actor, organizationId, eventId);
      if (update && !canEdit)
        throw new ApiError(403, 'FORBIDDEN', 'Доступен только просмотр черновика.');
      const document =
        event.document ??
        (await tx.draftDocument.create({
          data: {
            eventId,
            epoch: randomUUID(),
            state: initialDocument(event.description).state,
          },
        }));
      if (update && update.epoch !== document.epoch)
        throw new ApiError(
          409,
          'DOCUMENT_CHANGED',
          'Открыта другая версия документа. Сохраните локальные правки отдельно.',
        );
      let current = { state: new Uint8Array(document.state), text: event.description };
      if (update) {
        try {
          current = readDocument(document.state, Buffer.from(update.state, 'base64'));
        } catch {
          throw new ApiError(
            422,
            'INVALID_DOCUMENT',
            'Изменения не приняты: проверьте формат и лимит описания.',
          );
        }
      }
      let version = document.version;
      if (!Buffer.from(current.state).equals(Buffer.from(document.state))) {
        const saved = await tx.draftDocument.update({
          where: { eventId },
          data: { state: current.state, version: { increment: 1 } },
        });
        version = saved.version;
        if (current.text !== event.description) {
          await tx.eventDraft.update({
            where: { id: eventId },
            data: { description: current.text, revision: { increment: 1 } },
          });
          await tx.auditEntry.create({
            data: {
              organizationId,
              actorSubject: actor.subject,
              action: 'draft.description.updated',
              targetId: eventId,
              details: { version },
            },
          });
        }
      }
      return {
        epoch: document.epoch,
        state: Buffer.from(current.state).toString('base64'),
        version,
        canEdit,
        description: current.text,
      };
    });
  }
}
