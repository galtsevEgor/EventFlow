import { expect, it } from 'vitest';
import { Y, initialDocument, readDocument, MAX_DESCRIPTION_LENGTH } from '../src/index.js';

it('merges concurrent edits in either order, replays safely and preserves deleted text semantics', () => {
  const initial = initialDocument('Концерт');
  const a = new Y.Doc(),
    b = new Y.Doc();
  Y.applyUpdate(a, initial.state);
  Y.applyUpdate(b, initial.state);
  a.getText('description').insert(0, 'Живой ');
  b.getText('description').insert(7, ' вечером');
  const first = readDocument(initial.state, Y.encodeStateAsUpdate(a));
  const second = readDocument(first.state, Y.encodeStateAsUpdate(b));
  const reverse = readDocument(
    readDocument(initial.state, Y.encodeStateAsUpdate(b)).state,
    Y.encodeStateAsUpdate(a),
  );
  expect(second.text).toBe('Живой Концерт вечером');
  expect(reverse.text).toBe(second.text);
  expect(readDocument(second.state, Y.encodeStateAsUpdate(a)).state).toEqual(second.state);
  a.destroy();
  b.destroy();
});

it('rejects malformed state, foreign roots, embeds, formatting and oversized descriptions', () => {
  const base = initialDocument('');
  expect(() => readDocument(new Uint8Array([255]))).toThrow();
  for (const edit of [
    (d: Y.Doc) => d.getMap('prices').set('amount', 1),
    (d: Y.Doc) => d.getText('description').insertEmbed(0, { value: 'unsafe' }),
    (d: Y.Doc) => d.getText('description').insert(0, 'styled', { bold: true }),
    (d: Y.Doc) => d.getText('description').insert(0, 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1)),
  ]) {
    const doc = new Y.Doc();
    edit(doc);
    expect(() => readDocument(base.state, Y.encodeStateAsUpdate(doc))).toThrow();
    doc.destroy();
  }
});
