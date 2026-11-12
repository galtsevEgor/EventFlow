import type { ReactNode } from 'react';
import { SiteHeader } from '../site-header';
import '../account-page.css';
export const metadata = {
  title: 'Мои заказы — EventFlow',
  robots: { index: false, follow: false },
};
export default function OrdersLayout({ children }: { children: ReactNode }) {
  return (
    <main className="storefront-page account-page">
      <SiteHeader returnTo="/orders" />
      <div className="account-page-content">{children}</div>
      <footer className="site-footer">EventFlow</footer>
    </main>
  );
}
