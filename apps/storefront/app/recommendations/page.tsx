import Link from 'next/link';
import { Account } from '../account';
import { Preferences } from './preferences';

export default function RecommendationsPage() {
  return (
    <main>
      <Link className="brand" href="/">
        EventFlow<span aria-hidden="true">↗</span>
      </Link>
      <Account />
      <h1>Ваши мероприятия</h1>
      <Preferences />
    </main>
  );
}
