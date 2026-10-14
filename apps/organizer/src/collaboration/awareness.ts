import { Awareness, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import type { Member } from '@eventflow/collaboration';

export const REMOTE = 'eventflow-server';
export class PeerAwareness {
  private readonly clocks = new Map<number, number>();
  constructor(readonly awareness: Awareness) {}
  update(members: Member[]) {
    const others = members.filter((peer) => peer.clientId !== this.awareness.clientID);
    const present = new Set(others.map((peer) => peer.clientId));
    removeAwarenessStates(
      this.awareness,
      [...this.awareness.getStates().keys()].filter(
        (id) => id !== this.awareness.clientID && !present.has(id),
      ),
      REMOTE,
    );
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, others.length);
    for (const peer of others) {
      const clock = (this.clocks.get(peer.clientId) ?? 0) + 1;
      this.clocks.set(peer.clientId, clock);
      encoding.writeVarUint(encoder, peer.clientId);
      encoding.writeVarUint(encoder, clock);
      encoding.writeVarString(
        encoder,
        JSON.stringify({
          user: { name: peer.name, color: peer.color, colorLight: peer.color + '30' },
          cursor: peer.cursor,
        }),
      );
    }
    applyAwarenessUpdate(this.awareness, encoding.toUint8Array(encoder), REMOTE);
  }
}
