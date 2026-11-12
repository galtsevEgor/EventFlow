import { useEffect, useRef, useState } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap } from '@codemirror/commands';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import { MAX_DESCRIPTION_LENGTH } from '@eventflow/collaboration';
import { Button } from '@eventflow/ui';
import { invalidateEventList } from '../event-queries';
import { DraftClient, type EditorStatus } from './client';
const initial: EditorStatus = {
  ready: false,
  canEdit: false,
  connection: 'connecting',
  dirty: false,
  error: '',
  copyError: '',
  members: [],
};

export function CollaborativeEditor({
  organizationId,
  eventId,
  subject,
}: {
  organizationId: string;
  eventId: string;
  subject: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const current = useRef<DraftClient | null>(null);
  const [status, setStatus] = useState(initial);
  const [length, setLength] = useState(0);
  useEffect(() => {
    const writable = new Compartment();
    let view: EditorView | undefined;
    let editable = false;
    const client = new DraftClient(
      organizationId,
      eventId,
      subject,
      (status) => {
        setStatus(status);
        if (editable !== status.canEdit) {
          editable = status.canEdit;
          queueMicrotask(() =>
            view?.dispatch({
              effects: writable.reconfigure([
                EditorState.readOnly.of(!editable),
                EditorView.editable.of(editable),
              ]),
            }),
          );
        }
      },
      () => {
        void invalidateEventList(organizationId);
      },
    );
    current.current = client;
    const text = client.doc.getText('description');
    view = new EditorView({
      parent: container.current!,
      state: EditorState.create({
        doc: text.toString(),
        extensions: [
          writable.of([EditorState.readOnly.of(true), EditorView.editable.of(false)]),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({
            'aria-label': 'Совместное описание',
            role: 'textbox',
            'aria-multiline': 'true',
          }),
          keymap.of([...yUndoManagerKeymap, ...defaultKeymap]),
          yCollab(text, client.awareness),
          EditorState.transactionFilter.of((transaction) =>
            transaction.docChanged &&
            transaction.isUserEvent('input') &&
            transaction.newDoc.length > MAX_DESCRIPTION_LENGTH
              ? []
              : transaction,
          ),
        ],
      }),
    });
    const updateLength = () => setLength(text.length);
    text.observe(updateLength);
    updateLength();
    return () => {
      view?.destroy();
      view = undefined;
      client.destroy();
      current.current = null;
    };
  }, [organizationId, eventId, subject]);
  const label =
    status.connection === 'blocked'
      ? 'Синхронизация остановлена'
      : status.connection === 'offline'
        ? 'Нет связи — изменения сохраняются локально'
        : status.connection === 'connecting'
          ? 'Подключение…'
          : status.dirty
            ? 'Сохранение…'
            : 'Сохранено на сервере';
  function download() {
    const text = current.current?.doc.getText('description').toString() ?? '';
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'event-description.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className="collaborative-editor" aria-label="Совместный редактор">
      <div className="editor-status" role="status">
        {label}
      </div>
      <p className="muted">
        Описание черновика · {length}/{MAX_DESCRIPTION_LENGTH} ·{' '}
        {status.ready && !status.canEdit ? 'Только чтение' : 'Правки сохраняются автоматически'}
      </p>
      <ul className="editor-members" aria-label="Участники редактора">
        {status.members.map((peer) => (
          <li key={peer.peerId}>
            <span style={{ background: peer.color }} />
            {peer.name}
          </li>
        ))}
      </ul>
      <div className="editor-surface" ref={container} />
      {(status.error || status.copyError) && (
        <p role="alert">
          {status.error} {status.copyError}
        </p>
      )}
      <p className="muted">
        Локальная копия хранится в этой вкладке до 24 часов. Публикуются только подтверждённые
        сервером правки. Ctrl+Z отменяет ваши изменения.
      </p>
      <div className="editor-actions">
        <Button variant="secondary" onClick={download}>
          Скачать текст
        </Button>
        {status.connection === 'offline' && (
          <Button variant="secondary" onClick={() => current.current?.reconnect()}>
            Подключиться снова
          </Button>
        )}
      </div>
    </section>
  );
}
