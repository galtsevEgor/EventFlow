import { Alert, Button } from '@eventflow/ui';
import { formatLocalTime } from '@eventflow/ui/format';
import type { Snapshot } from './database';

export function GatePreparation({
  snapshot,
  expired,
  canPrepare,
  onPrepare,
}: {
  snapshot: Snapshot | undefined;
  expired: boolean;
  canPrepare: boolean;
  onPrepare: () => void;
}) {
  return (
    <section aria-label="Подготовка сканера">
      <h2>Подготовка</h2>
      <Button disabled={!canPrepare} onClick={onPrepare}>
        Подготовить мероприятие
      </Button>
      {snapshot && (
        <p>
          В снимке: {snapshot.manifest.hashes.length} билетов. Действует до{' '}
          <time dateTime={snapshot.manifest.expiresAt}>
            {formatLocalTime(snapshot.manifest.expiresAt)}
          </time>
          .
        </p>
      )}
      {expired && snapshot && (
        <Alert>
          Снимок устарел. Обновите подготовку онлайн. Сохранённые проверки остаются в очереди.
        </Alert>
      )}
      {snapshot?.blocked && (
        <Alert>
          Права на мероприятие изменились. Подготовьте снимок заново после восстановления доступа.
        </Alert>
      )}
    </section>
  );
}
