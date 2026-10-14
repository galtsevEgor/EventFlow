import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { ApiError } from '@eventflow/service-runtime';
import { clientFrameSchema, type DraftSnapshot, type ServerFrame } from '@eventflow/collaboration';
import { DocumentAccess } from './access';
import { CollaborationBus } from './bus';

export class DocumentSession {
  readonly peerId = randomUUID();
  private closed = false;
  private joined = false;
  private alive = true;
  private pending = 0;
  private windowAt = Date.now();
  private messages = 0;
  private processing = Promise.resolve();
  private refreshing = false;
  private readonly timer;
  private ticks = 0;

  constructor(
    readonly socket: WebSocket,
    readonly access: DocumentAccess,
    private snapshot: DraftSnapshot,
    private readonly bus: CollaborationBus,
    private readonly remove: () => void,
  ) {
    socket.on('error', () => this.stop());
    socket.on('close', () => this.stop());
    socket.on('pong', () => {
      this.alive = true;
    });
    socket.on('message', (data, binary) => {
      if (binary) {
        this.fail(new ApiError(422, 'INVALID_MESSAGE', 'Ожидается сообщение редактора.'));
        return;
      }
      if (Date.now() - this.windowAt >= 1000) {
        this.windowAt = Date.now();
        this.messages = 0;
      }
      if (++this.messages > 20 || this.pending >= 4) {
        this.fail(new ApiError(429, 'EDITOR_BUSY', 'Слишком много изменений.'));
        return;
      }
      this.pending++;
      this.processing = this.processing
        .then(async () => {
          if (this.closed) return;
          const parsed = clientFrameSchema.safeParse(JSON.parse(data.toString()));
          if (!parsed.success)
            throw new ApiError(422, 'INVALID_MESSAGE', 'Некорректное сообщение редактора.');
          if (parsed.data.type === 'join') {
            if (this.joined) throw new ApiError(422, 'INVALID_MESSAGE', 'Повторное начало сессии.');
            this.joined = true;
            this.send({ type: 'snapshot', snapshot: this.snapshot, peerId: this.peerId });
            return;
          }
          if (!this.joined)
            throw new ApiError(422, 'INVALID_MESSAGE', 'Сначала откройте документ.');
          const next = await this.access.load({
            epoch: parsed.data.epoch,
            state: parsed.data.state,
          });
          if (next.version >= this.snapshot.version) this.snapshot = next;
          this.send({ type: 'ack', id: parsed.data.id, snapshot: next });
          void this.bus.publish(this.access.target).catch(() => {});
        })
        .catch((error) => this.fail(error))
        .finally(() => {
          this.pending--;
        });
    });
    this.timer = setInterval(() => {
      void this.refresh();
      if (++this.ticks % 5 === 0) {
        if (!this.alive) {
          this.stop();
          return;
        }
        this.alive = false;
        socket.ping();
      }
    }, 2000);
    this.send({ type: 'snapshot', snapshot, peerId: this.peerId });
  }

  send(frame: ServerFrame) {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return;
    if (this.socket.bufferedAmount > 256 * 1024) {
      this.stop();
      return;
    }
    this.socket.send(JSON.stringify(frame));
  }
  async refresh() {
    if (this.closed || this.refreshing) return;
    this.refreshing = true;
    try {
      const next = await this.access.load();
      if (this.closed) return;
      if (next.version > this.snapshot.version || next.canEdit !== this.snapshot.canEdit) {
        if (next.version >= this.snapshot.version) this.snapshot = next;
        this.send({ type: 'snapshot', snapshot: this.snapshot, peerId: this.peerId });
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.refreshing = false;
    }
  }
  fail(error: unknown) {
    const status =
      error instanceof ApiError ? error.getStatus() : error instanceof SyntaxError ? 422 : 503;
    const problem =
      error instanceof ApiError
        ? (error.getResponse() as { code: string; message: string })
        : { code: 'COLLABORATION_UNAVAILABLE', message: 'Редактор временно недоступен.' };
    this.send({ type: 'error', ...problem });
    this.stop(status === 503 || status === 429 ? 1013 : 1008);
  }
  stop(code = 1013) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.remove();
    this.socket.close(code);
    const deadline = setTimeout(() => this.socket.terminate(), 1000);
    deadline.unref();
    this.socket.once('close', () => clearTimeout(deadline));
  }
}
