import Link from 'next/link';
import { SiteHeader } from './site-header';

export default function NotFound() {
  return (
    <main className="storefront-page">
      <SiteHeader />
      <section className="site-message">
        <h1>Страница не найдена</h1>
        <Link className="site-action" href="/">
          Вернуться в каталог
        </Link>
      </section>
    </main>
  );
}
