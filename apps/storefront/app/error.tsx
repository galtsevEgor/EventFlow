'use client';
import { SiteHeader } from './site-header';

export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="storefront-page">
      <SiteHeader />
      <section className="site-message">
        <h1>Не удалось загрузить страницу</h1>
        <p>Попробуйте ещё раз через несколько секунд.</p>
        <div className="site-message-actions">
          <button className="site-action" type="button" onClick={reset}>
            Повторить
          </button>
          <a className="back-link" href="/">
            Вернуться в каталог
          </a>
        </div>
      </section>
    </main>
  );
}
