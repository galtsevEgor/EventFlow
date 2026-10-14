import {
  Y,
  serverFrameSchema,
  cursorSchema,
  MAX_DOCUMENT_BYTES,
  type Member,
  type DraftSnapshot,
} from '@eventflow/collaboration';
import { Awareness } from 'y-protocols/awareness';
import { cacheKey, loadCopy, saveCopy, type CachedDraft } from './cache';
import { PeerAwareness, REMOTE } from './awareness';

export type EditorStatus = {
  ready: boolean;
  canEdit: boolean;
  connection: 'connecting' | 'online' | 'offline' | 'blocked';
  dirty: boolean;
  error: string;
  copyError: string;
  members: Member[];
};
export const encodeDocument = (doc: Y.Doc) =>
  btoa(String.fromCharCode(...Y.encodeStateAsUpdate(doc)));
const decode = (state: string) => Uint8Array.from(atob(state), (char) => char.charCodeAt(0));

export class DraftClient {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  private readonly peers = new PeerAwareness(this.awareness);
  private readonly key;
  private cached: CachedDraft | null = null;
  private epoch = '';
  private generation = 0;
  private acknowledged = 0;
  private inflight: CachedDraft['inflight'] = null;
  private socket: WebSocket | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private sending: ReturnType<typeof setTimeout> | undefined;
  private cursorTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private received = false;
  private attempts = 0;
  private sentId = '';
  private acknowledgementTimer: ReturnType<typeof setTimeout> | undefined;
  status: EditorStatus = {
    ready: false,
    canEdit: false,
    connection: 'connecting',
    dirty: false,
    error: '',
    copyError: '',
    members: [],
  };

  constructor(
    readonly organizationId: string,
    readonly eventId: string,
    subject: string,
    private readonly changed: (status: EditorStatus) => void,
    private readonly saved: () => void,
  ) {
    this.key = cacheKey(subject, organizationId, eventId);
    try {
      this.cached = loadCopy(sessionStorage, this.key);
      if (this.cached) {
        Y.applyUpdate(this.doc, decode(this.cached.state), REMOTE);
        this.generation = this.cached.generation;
        this.acknowledged = this.cached.acknowledged;
        this.inflight = this.cached.inflight;
        this.epoch = this.cached.epoch;
      }
    } catch {
      this.status.copyError =
        'Не удалось прочитать локальную копию. Она сохранена в хранилище вкладки; автоматическая перезапись остановлена.';
      this.status.connection = 'blocked';
      this.emit();
      return;
    }
    this.doc.on('update', (_bytes: Uint8Array, origin: unknown) => {
      if (origin === REMOTE) return;
      this.generation++;
      this.persist();
      this.emit();
      clearTimeout(this.sending);
      this.sending = setTimeout(() => this.flush(), 300);
    });
    this.awareness.on('update', (_change: unknown, origin: unknown) => {
      if (origin === REMOTE || this.stopped) return;
      clearTimeout(this.cursorTimer);
      this.cursorTimer = setTimeout(() => {
        const cursor = cursorSchema.safeParse(this.awareness.getLocalState()?.cursor ?? null);
        if (cursor.success && this.received) this.send({ type: 'presence', cursor: cursor.data });
      }, 150);
    });
    window.addEventListener('online', this.reconnect);
    window.addEventListener('beforeunload', this.beforeUnload);
    this.connect();
  }
  private readonly beforeUnload = (event: BeforeUnloadEvent) => {
    if (this.generation > this.acknowledged) {
      event.preventDefault();
      event.returnValue = '';
    }
  };
  readonly reconnect = () => {
    if (this.stopped || this.status.connection === 'blocked') return;
    clearTimeout(this.retry);
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) return;
    this.connect();
  };
  private emit() {
    this.status = { ...this.status, dirty: this.generation > this.acknowledged || !!this.inflight };
    this.changed(this.status);
  }
  private persist() {
    if (!this.epoch) return;
    try {
      saveCopy(sessionStorage, this.key, {
        epoch: this.epoch,
        state: encodeDocument(this.doc),
        generation: this.generation,
        acknowledged: this.acknowledged,
        inflight: this.inflight,
        updatedAt: Date.now(),
      });
      this.status.copyError = '';
    } catch {
      this.status.copyError = 'Локальная копия недоступна. Скачайте текст перед закрытием.';
    }
  }
  private send(frame: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame));
  }
  private connect() {
    this.received = false;
    this.sentId = '';
    this.status.connection = 'connecting';
    this.emit();
    const url = new URL(
      '/api/v1/organizations/' +
        this.organizationId +
        '/events/' +
        this.eventId +
        '/collaboration/socket',
      location.origin,
    );
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = (this.socket = new WebSocket(url));
    socket.onopen = () => this.send({ type: 'join', clientId: this.doc.clientID });
    socket.onmessage = (event) => {
      try {
        const parsed = serverFrameSchema.safeParse(JSON.parse(event.data));
        if (!parsed.success) throw new Error('Некорректный ответ редактора.');
        const frame = parsed.data;
        if (frame.type === 'error') {
          this.status.error = frame.message;
          if (!['COLLABORATION_UNAVAILABLE', 'EDITOR_BUSY'].includes(frame.code)) {
            this.status.connection = 'blocked';
            this.status.canEdit = false;
          }
          this.emit();
          return;
        }
        if (frame.type === 'members') {
          this.status.members = frame.members;
          this.peers.update(frame.members);
          this.emit();
          return;
        }
        if (!this.accept(frame.snapshot)) return;
        if (frame.type === 'ack' && this.inflight?.id === frame.id) {
          clearTimeout(this.acknowledgementTimer);
          this.sentId = '';
          this.acknowledged = this.inflight.generation;
          this.inflight = null;
          this.persist();
          this.saved();
        }
        this.emit();
        this.flush();
      } catch {
        this.status.error = 'Не удалось синхронизировать документ. Скачайте локальный текст.';
        this.status.connection = 'blocked';
        this.status.canEdit = false;
        this.emit();
        socket.close();
      }
    };
    socket.onerror = () => {
      /* onclose schedules bounded reconnect. */
    };
    socket.onclose = () => {
      if (this.stopped) return;
      this.received = false;
      this.status.members = [];
      this.peers.update([]);
      if (this.status.connection === 'blocked') {
        this.emit();
        return;
      }
      this.status.connection = 'offline';
      this.emit();
      this.retry = setTimeout(
        this.reconnect,
        Math.min(10000, 500 * 2 ** Math.min(this.attempts++, 5)),
      );
    };
  }
  private accept(snapshot: DraftSnapshot) {
    if (this.epoch && snapshot.epoch !== this.epoch) {
      this.status.error = 'Версия документа изменилась. Локальная копия сохранена; скачайте её.';
      this.status.connection = 'blocked';
      this.status.canEdit = false;
      this.emit();
      this.socket?.close();
      return false;
    }
    this.epoch = snapshot.epoch;
    Y.applyUpdate(this.doc, decode(snapshot.state), REMOTE);
    this.received = true;
    this.attempts = 0;
    this.status.ready = true;
    this.status.connection = 'online';
    this.status.error = '';
    this.status.canEdit = snapshot.canEdit;
    if (!snapshot.canEdit && this.generation > this.acknowledged)
      this.status.error =
        'Доступ только для чтения. Ваши неподтверждённые правки доступны для скачивания.';
    this.persist();
    return true;
  }
  private flush() {
    if (!this.received || !this.status.canEdit || this.status.connection !== 'online') return;
    if (!this.inflight && this.generation > this.acknowledged) {
      const state = encodeDocument(this.doc);
      if (decode(state).byteLength > MAX_DOCUMENT_BYTES) {
        this.status.error = 'Документ достиг лимита. Скачайте текст и сохраните его отдельно.';
        this.status.connection = 'blocked';
        this.status.canEdit = false;
        this.emit();
        return;
      }
      this.inflight = {
        id: crypto.randomUUID(),
        epoch: this.epoch,
        state,
        generation: this.generation,
      };
      this.persist();
    }
    if (this.inflight && this.sentId !== this.inflight.id) {
      const { id, epoch, state } = this.inflight;
      this.sentId = id;
      this.send({ type: 'update', id, epoch, state });
      clearTimeout(this.acknowledgementTimer);
      this.acknowledgementTimer = setTimeout(() => {
        this.sentId = '';
        this.flush();
      }, 5000);
    }
  }
  destroy() {
    this.persist();
    this.stopped = true;
    clearTimeout(this.retry);
    clearTimeout(this.sending);
    clearTimeout(this.cursorTimer);
    clearTimeout(this.acknowledgementTimer);
    window.removeEventListener('online', this.reconnect);
    window.removeEventListener('beforeunload', this.beforeUnload);
    this.socket?.close();
    this.awareness.destroy();
    this.doc.destroy();
  }
}
