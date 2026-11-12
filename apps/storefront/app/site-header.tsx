import Link from 'next/link';
import { Account } from './account';

export function SiteHeader({ returnTo = '/' }: { returnTo?: string }) {
  return (
    <header className="site-header">
      <Link href="/" className="site-brand">
        <span className="site-brand-mark" aria-hidden="true" />
        EventFlow
      </Link>
      <Account returnTo={returnTo} />
    </header>
  );
}
