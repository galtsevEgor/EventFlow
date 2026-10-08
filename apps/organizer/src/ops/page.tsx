import { Alert, Badge } from '@eventflow/ui';
import { targetSchema } from './model';
import { OperatorCase } from './case';
import { OperatorList } from './list';
import './styles.css';
export default function OperatorPage({
  actor,
  canRecover,
}: {
  actor: string;
  canRecover: boolean;
}) {
  const params = new URLSearchParams(location.search),
    hasCase = params.has('id'),
    parsed = targetSchema.safeParse({
      service: params.get('source'),
      kind: params.get('kind'),
      id: params.get('id'),
    });
  return (
    <div className="ops-console">
      <div className="ops-heading">
        <div>
          <h1>Кабинет оператора</h1>
          <p className="muted">Разбор проблем и контролируемое восстановление обработки.</p>
        </div>
        <Badge>{canRecover ? 'Восстановление доступно' : 'Только просмотр'}</Badge>
      </div>
      <p>
        <a href="/organizer/">К организациям</a>
      </p>
      {hasCase ? (
        parsed.success ? (
          <OperatorCase
            key={`${parsed.data.service}:${parsed.data.kind}:${parsed.data.id}`}
            actor={actor}
            target={parsed.data}
            canRecover={canRecover}
          />
        ) : (
          <Alert>
            Некорректная ссылка на запись. <a href="/organizer/ops">Открыть список</a>
          </Alert>
        )
      ) : (
        <OperatorList actor={actor} />
      )}
    </div>
  );
}
