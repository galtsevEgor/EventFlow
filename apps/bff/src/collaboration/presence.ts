import { ApiError } from '@eventflow/service-runtime';
import { memberSchema, type Member } from '@eventflow/collaboration';
import { SessionStore } from '../auth/session-store';
import type { DocumentTarget } from './access';
import { roomId } from './bus';

// Redis time and one atomic script make the room limit apply across replicas.
const touch = [
  "local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000)",
  "local incoming=cjson.decode(ARGV[2]); local entries=redis.call('HGETALL',KEYS[1]); local count=0",
  'for i=1,#entries,2 do',
  'local peer=cjson.decode(entries[i+1])',
  "if peer.expiresAt<=now then redis.call('HDEL',KEYS[1],entries[i])",
  'elseif entries[i]~=ARGV[1] then',
  'if peer.clientId==incoming.clientId then return -2 end',
  'count=count+1 end end',
  'if count>=16 then return -1 end',
  'incoming.expiresAt=now+15000',
  "redis.call('HSET',KEYS[1],ARGV[1],cjson.encode(incoming)); redis.call('PEXPIRE',KEYS[1],30000)",
  "return redis.call('HVALS',KEYS[1])",
].join('\n');

export class DocumentPresence {
  constructor(
    private readonly store: SessionStore,
    private readonly prefix: string,
  ) {}
  key(target: DocumentTarget) {
    return this.prefix + 'collaboration:room:' + roomId(target);
  }
  async touch(target: DocumentTarget, member: Member): Promise<Member[]> {
    const result = await this.store.execute(() =>
      this.store.client.withCommandOptions({ timeout: 2000 }).eval(touch, {
        keys: [this.key(target)],
        arguments: [member.peerId, JSON.stringify(member)],
      }),
    );
    if (result === -1 || result === -2)
      throw new ApiError(
        429,
        'ROOM_FULL',
        'В комнате нет свободных мест или вкладка уже подключена.',
      );
    return (result as string[])
      .map((raw) => {
        const peer = JSON.parse(raw);
        delete peer.expiresAt;
        return memberSchema.parse(peer);
      })
      .sort((a, b) => a.peerId.localeCompare(b.peerId));
  }
  async leave(target: DocumentTarget, peerId: string) {
    await this.store.execute(() => this.store.client.hDel(this.key(target), peerId));
  }
}
