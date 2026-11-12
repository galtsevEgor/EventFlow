import { Button } from '@eventflow/ui';
import { formatLocalDateTime } from '@eventflow/ui/format';
import type { Scan } from './database';

const MAX_VISIBLE_SCAN_RESULTS = 50;
const MINUTE_MS = 60_000;
const labels = {
  ADMITTED: 'Допуск подтверждён сервером',
  ALREADY_USED: 'Конфликт: билет уже использован',
  WRONG_EVENT: 'Билет другого мероприятия',
  INVALID_TICKET: 'Билет не найден',
  WINDOW_CLOSED: 'Окно допуска закрыто',
  REFUND_PENDING: 'Возврат проверяется',
  REFUNDED: 'Билет аннулирован',
};

function resultLabel({ state, result }: Scan) {
  if (state === 'PENDING') return 'Сохранено на устройстве — ожидает синхронизации';
  if (!result) return 'Нет результата';
  if (result.reason === 'SNAPSHOT_EXPIRED') return 'Снимок истёк до синхронизации';
  if (result.reason === 'NOT_IN_SNAPSHOT') return 'Билет отсутствует в снимке';
  return labels[result.result];
}

function ScanResult({ scan }: { scan: Scan }) {
  const status =
    scan.state === 'PENDING'
      ? 'pending'
      : scan.result?.result === 'ADMITTED'
        ? 'confirmed'
        : 'conflict';
  return (
    <li className={'gate-result ' + status}>
      <strong>{resultLabel(scan)}</strong>
      <small>
        {formatLocalDateTime(scan.capturedAt)} · операция {scan.requestId.slice(0, 8)}
      </small>
    </li>
  );
}

export function GateScanQueue({
  rows,
  now,
  canSync,
  syncing,
  onSync,
}: {
  rows: Scan[];
  now: number;
  canSync: boolean;
  syncing: boolean;
  onSync: () => void;
}) {
  const pendingRows = rows.filter((scan) => scan.state === 'PENDING');
  const confirmed = rows.filter((scan) => scan.result?.result === 'ADMITTED').length;
  const attention = rows.length - pendingRows.length - confirmed;
  const oldestCapture = pendingRows.reduce(
    (oldest, scan) => Math.min(oldest, Date.parse(scan.capturedAt)),
    now,
  );
  const oldestMinutes = Math.floor((now - oldestCapture) / MINUTE_MS);

  return (
    <section aria-label="Очередь синхронизации">
      <h2>Очередь: {pendingRows.length}</h2>
      <p className="muted">
        Подтверждено: {confirmed} · Требует внимания: {attention}
        {pendingRows.length > 0 && <> · Старейшая проверка ожидает {oldestMinutes} мин.</>}
      </p>
      <Button disabled={!canSync} onClick={onSync}>
        {syncing ? 'Синхронизируем…' : 'Синхронизировать'}
      </Button>
      <p className="muted">
        Отправляем при открытом приложении. При потере ответа повторяем сохранённую операцию.
      </p>
      <ol className="gate-results">
        {rows
          .slice(-MAX_VISIBLE_SCAN_RESULTS)
          .reverse()
          .map((scan) => (
            <ScanResult key={scan.requestId} scan={scan} />
          ))}
      </ol>
      {rows.length === 0 && <p>На этом устройстве пока нет проверок.</p>}
    </section>
  );
}
