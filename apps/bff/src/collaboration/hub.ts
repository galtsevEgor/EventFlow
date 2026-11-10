import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { HttpAdapterHost } from '@nestjs/core';
import { ApiError } from '@eventflow/service-runtime';
import { AuthService } from '../auth/auth.service';
import { DocumentAccess, socketRequest } from './access';
import { CollaborationBus, roomId } from './bus';
import { DocumentSession } from './session';
import { DocumentPresence } from './presence';

const COLLABORATION_OPEN_RATE_LIMIT = 60;

const path =
  /^\/api\/v1\/organizations\/([a-f0-9-]{36})\/events\/([a-f0-9-]{36})\/collaboration\/socket$/i;

export class CollaborationHub {
  readonly sessions = new Set<DocumentSession>();
  private readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: 96 * 1024,
    perMessageDeflate: false,
  });
  private http: Server | undefined;
  private opening = 0;
  constructor(
    private readonly adapter: HttpAdapterHost,
    private readonly auth: AuthService,
    private readonly bus: CollaborationBus,
    private readonly presence: DocumentPresence,
  ) {}
  private readonly notify = (target: { organizationId: string; eventId: string }) => {
    for (const session of this.sessions)
      if (roomId(session.access.target) === roomId(target)) void session.refresh();
  };
  private readonly upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    if (this.sessions.size + this.opening >= 64) {
      socket.end('HTTP/1.1 429 Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    this.opening++;
    void this.open(request, socket, head)
      .catch((error) => {
        if (socket.destroyed) return;
        const status = error instanceof ApiError ? error.getStatus() : 503;
        socket.end(
          'HTTP/1.1 ' + status + ' Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
        );
      })
      .finally(() => {
        this.opening--;
      });
  };
  async onModuleInit() {
    this.http = this.adapter.httpAdapter.getHttpServer() as Server;
    this.http.on('upgrade', this.upgrade);
    this.bus.listeners.add(this.notify);
  }
  private async open(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(request.url ?? '/', 'http://bff');
    const match = url.pathname.match(path);
    if (!match || url.search) throw new ApiError(404, 'NOT_FOUND', 'Маршрут не найден.');
    if (
      request.headers.origin !== this.auth.config.PUBLIC_ORIGIN ||
      request.headers['sec-websocket-protocol']
    )
      throw new ApiError(403, 'FORBIDDEN', 'Подключение недоступно.');
    if (this.sessions.size >= 64) throw new ApiError(429, 'EDITOR_BUSY', 'Редактор занят.');
    const req = socketRequest(request);
    const initial = await this.auth.requireSession(req);
    await this.auth.store.rateLimit(
      'collaboration-open:' + initial.session.user.sub,
      COLLABORATION_OPEN_RATE_LIMIT,
    );
    const access = new DocumentAccess(this.auth, req, {
      organizationId: match[1]!.toLowerCase(),
      eventId: match[2]!.toLowerCase(),
    });
    const snapshot = await access.load();
    if (socket.destroyed) return;
    this.server.handleUpgrade(request, socket, head, (ws) => {
      const session = new DocumentSession(ws, access, snapshot, this.bus, this.presence, () =>
        this.sessions.delete(session),
      );
      this.sessions.add(session);
    });
  }
  onModuleDestroy() {
    this.http?.off('upgrade', this.upgrade);
    this.bus.listeners.delete(this.notify);
    for (const session of this.sessions) {
      session.stop();
      session.socket.terminate();
    }
    this.sessions.clear();
    this.server.close();
  }
}
