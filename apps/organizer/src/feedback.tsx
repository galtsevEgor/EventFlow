import { Alert } from '@eventflow/ui';
import { ApiRequestError } from './api';

export function ErrorMessage({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <Alert>
      {error instanceof ApiRequestError ? (
        <>
          {error.message}
          {error.problem.fieldErrors && (
            <ul>
              {Object.values(error.problem.fieldErrors)
                .flat()
                .map((message, index) => (
                  <li key={index}>{message}</li>
                ))}
            </ul>
          )}
          <small className="request-id">Код обращения: {error.problem.requestId}</small>
          {error.problem.code === 'UNAUTHENTICATED' && (
            <a
              href={`/api/v1/auth/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`}
            >
              Войти снова
            </a>
          )}
        </>
      ) : (
        'Не удалось выполнить запрос. Проверьте соединение и повторите попытку.'
      )}
    </Alert>
  );
}
