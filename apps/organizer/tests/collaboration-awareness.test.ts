import { expect, it } from 'vitest';
import { Y, MAX_DOCUMENT_BYTES, initialDocument, readDocument } from '@eventflow/collaboration';
import { Awareness } from 'y-protocols/awareness';
import { PeerAwareness } from '../src/collaboration/awareness';
import { encodeDocument } from '../src/collaboration/client';

it('idle heartbeats refresh remote clocks, reconnect restores the peer and own identity cannot be overwritten', () => {
  const doc = new Y.Doc(),
    awareness = new Awareness(doc),
    bridge = new PeerAwareness(awareness);
  const peer = {
    peerId: '11111111-1111-4111-8111-111111111111',
    clientId: (doc.clientID + 1) >>> 0,
    name: 'Коллега',
    color: '#315eac',
    cursor: null,
  };
  try {
    awareness.setLocalState({ user: { name: 'Я' } });
    bridge.update([peer]);
    const clock = awareness.meta.get(peer.clientId)!.clock;
    bridge.update([peer]);
    expect(awareness.meta.get(peer.clientId)!.clock).toBeGreaterThan(clock);
    expect(awareness.getStates().get(peer.clientId)?.user.name).toBe('Коллега');
    bridge.update([]);
    expect(awareness.getStates().has(peer.clientId)).toBe(false);
    bridge.update([peer, { ...peer, clientId: doc.clientID, name: 'Подмена' }]);
    expect(awareness.getStates().has(peer.clientId)).toBe(true);
    expect(awareness.getLocalState()?.user.name).toBe('Я');
  } finally {
    doc.destroy();
  }
});

it('oversized local edit history encodes without a stack overflow and is still rejected by the document limit', () => {
  const doc = new Y.Doc({ gc: false }),
    text = doc.getText('description');
  try {
    for (let i = 0; i < 40; i++) {
      if (text.length) text.delete(0, text.length);
      text.insert(0, String(i % 10).repeat(5000));
    }
    expect(text.length).toBe(5000);
    const bytes = Y.encodeStateAsUpdate(doc);
    expect(bytes.byteLength).toBeGreaterThan(MAX_DOCUMENT_BYTES);
    const encoded = encodeDocument(doc);
    expect(new Uint8Array(Buffer.from(encoded, 'base64'))).toEqual(bytes);
    expect(() => readDocument(initialDocument('').state, bytes)).toThrow('DOCUMENT_LIMIT');
  } finally {
    doc.destroy();
  }
});
