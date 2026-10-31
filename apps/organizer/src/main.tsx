import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { App } from './app';
import { queryClient } from './api';
import './styles.css';

const root = document.getElementById('root');
const GateApp = lazy(() => import('./gate/app').then((m) => ({ default: m.GateApp })));
if (!root) throw new Error('Application root is missing');
createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {location.pathname.startsWith('/organizer/gate') ? (
        <Suspense fallback={<p>Открываем сканер…</p>}>
          <GateApp />
        </Suspense>
      ) : (
        <App />
      )}
    </QueryClientProvider>
  </StrictMode>,
);
