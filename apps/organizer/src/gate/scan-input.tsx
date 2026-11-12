import { useCallback, useState } from 'react';
import { Button, Field } from '@eventflow/ui';
import { GateCamera } from './camera';
import type { ScannerWorker } from './worker-client';

const credentialPattern = /^[A-Za-z0-9_-]{32}$/;

export function GateScanInput({
  worker,
  canCapture,
  capturing,
  capture,
}: {
  worker: ScannerWorker | null;
  canCapture: boolean;
  capturing: boolean;
  capture: (code: string, options: { onSuccess: () => void }) => void;
}) {
  const [credential, setCredential] = useState('');
  const [camera, setCamera] = useState(false);
  const disabled = !canCapture || capturing;
  const submit = useCallback(
    (code: string) => {
      setCamera(false);
      capture(code, { onSuccess: () => setCredential('') });
    },
    [capture],
  );
  return (
    <section aria-label="Сканирование">
      <h2>Сканировать билет</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit(credential.trim());
        }}
      >
        <Field
          label="Код билета"
          value={credential}
          onChange={(event) => setCredential(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
        />
        <div className="gate-actions">
          <Button type="submit" disabled={disabled || !credentialPattern.test(credential.trim())}>
            Сохранить проверку
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={disabled}
            onClick={() => setCamera(!camera)}
          >
            {camera ? 'Закрыть камеру' : 'Открыть камеру'}
          </Button>
        </div>
      </form>
      {camera && worker && <GateCamera worker={worker} onCode={submit} />}
      {capturing && <p role="status">Сохраняем проверку…</p>}
    </section>
  );
}
