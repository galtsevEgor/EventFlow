import { SiteHeader } from '../site-header';
import { Preferences } from './preferences';
import '../account-page.css';

export default function RecommendationsPage() {
  return (
    <main className="storefront-page account-page">
      <SiteHeader returnTo="/recommendations" />
      <div className="account-page-content">
        <div className="account-page-heading">
          <h1>Ваши мероприятия</h1>
        </div>
        <Preferences />
      </div>
      <footer className="site-footer">EventFlow</footer>
    </main>
  );
}
