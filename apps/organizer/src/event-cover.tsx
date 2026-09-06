import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Alert, Button, Field } from '@eventflow/ui';
import { api, queryClient, unwrap, type Schemas } from './api';
import { ErrorMessage } from './feedback';

export function EventCover({
  id,
  event,
  onSaved,
}: {
  id: string;
  event: Schemas['Draft'];
  onSaved: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const upload = useMutation({
    mutationFn: async (file: File) =>
      unwrap(
        await api.client.POST('/api/v1/organizations/{id}/events/{eventId}/cover', {
          params: { path: { id, eventId: event.id } },
          body: { file },
          bodySerializer(body) {
            const data = new FormData();
            data.set('file', body.file, 'cover');
            return data;
          },
        }),
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['events', id] });
      onSaved();
    },
  });
  function submit(formEvent: FormEvent) {
    formEvent.preventDefault();
    setError('');
    if (!file) {
      setError('Выберите файл.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('Максимальный размер афиши — 5 MiB.');
      return;
    }
    upload.mutate(file);
  }
  return (
    <form onSubmit={submit}>
      {event.coverId && (
        <img
          className="cover-preview"
          src={`/api/v1/organizations/${id}/events/${event.id}/cover?v=${event.coverId}`}
          alt={`Афиша: ${event.title}`}
        />
      )}
      <Field
        label="Файл афиши"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        required
        disabled={upload.isPending}
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />
      {error && <Alert>{error}</Alert>}
      <ErrorMessage error={upload.error} />
      <Button type="submit" disabled={upload.isPending}>
        {upload.isPending ? 'Проверка изображения…' : 'Загрузить афишу'}
      </Button>
    </form>
  );
}
