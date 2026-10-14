import * as Y from 'yjs';
import { MAX_DESCRIPTION_LENGTH, MAX_DOCUMENT_BYTES } from './protocol.js';

function checkUpdate(state: Uint8Array) {
  if (!state.length || state.byteLength > MAX_DOCUMENT_BYTES) throw new Error('DOCUMENT_LIMIT');
  const decoded = Y.decodeUpdate(state);
  if (decoded.structs.length > 50000) throw new Error('DOCUMENT_LIMIT');
  for (const item of decoded.structs) {
    if (item.length > 1_000_000 || item.id.clock > 1_000_000_000) throw new Error('DOCUMENT_LIMIT');
    if (
      item instanceof Y.Item &&
      (item.parentSub !== null ||
        (typeof item.parent === 'string' && item.parent !== 'description') ||
        (!(item.content instanceof Y.ContentString) && !(item.content instanceof Y.ContentDeleted)))
    )
      throw new Error('INVALID_DOCUMENT');
  }
}

export function readDocument(state: Uint8Array, update?: Uint8Array) {
  const doc = new Y.Doc();
  try {
    checkUpdate(state);
    doc.getText('description');
    Y.applyUpdate(doc, state);
    if (update) {
      checkUpdate(update);
      Y.applyUpdate(doc, update);
    }
    if (
      doc.store.pendingStructs ||
      doc.store.pendingDs ||
      [...doc.share.keys()].some((key) => key !== 'description')
    )
      throw new Error('INVALID_DOCUMENT');
    const text = doc.getText('description').toString();
    const compacted = Y.encodeStateAsUpdate(doc);
    if (text.length > MAX_DESCRIPTION_LENGTH || compacted.byteLength > MAX_DOCUMENT_BYTES)
      throw new Error('DOCUMENT_LIMIT');
    return { state: new Uint8Array(compacted), text };
  } finally {
    doc.destroy();
  }
}

export function initialDocument(text: string) {
  const doc = new Y.Doc();
  try {
    doc.getText('description').insert(0, text);
    return readDocument(Y.encodeStateAsUpdate(doc));
  } finally {
    doc.destroy();
  }
}
