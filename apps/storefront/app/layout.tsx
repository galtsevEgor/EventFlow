import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import '@eventflow/ui/brand.css';
import './styles.css';
import './theme.css';
import { AnalyticsCollector } from './analytics';

export const metadata: Metadata = {
  metadataBase: new URL(process.env.PUBLIC_ORIGIN ?? 'http://127.0.0.1:18000'),
  title: 'EventFlow — события и билеты',
  description: 'Находите мероприятия и сохраняйте билеты в одном месте.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ru">
      <body>
        <AnalyticsCollector />
        {children}
      </body>
    </html>
  );
}
