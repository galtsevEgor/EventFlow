import type { ReactNode } from 'react';
import { Account } from '../account';
export const metadata = {
  title: 'Мои заказы — EventFlow',
  robots: { index: false, follow: false },
};
export default function OrdersLayout({ children }: { children: ReactNode }) {
  return (
    <main>
      <a href="/" className="brand">
        EventFlow<span aria-hidden="true">↗</span>
      </a>
      <Account />
      <section className="event-detail">{children}</section>
    </main>
  );
}
