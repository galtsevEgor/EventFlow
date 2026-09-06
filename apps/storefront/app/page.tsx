import { Account } from './account';
import type { Metadata } from 'next';
import { ApiRequestError } from '@eventflow/api-client';
import { listEvents, type Search } from './catalog-api';
import { EventList } from './event-list';

export const dynamic = 'force-dynamic';
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Search>;
}): Promise<Metadata> {
  const search = await searchParams;
  return {
    title: 'EventFlow — афиша мероприятий и билеты',
    alternates: { canonical: '/' },
    robots: Object.values(search).some(Boolean)
      ? { index: false, follow: true }
      : { index: true, follow: true },
  };
}

export default async function Home({ searchParams }: { searchParams: Promise<Search> }) {
  const search = await searchParams;
  let result,
    error = '';
  try {
    result = await listEvents(search);
  } catch (cause) {
    error =
      cause instanceof ApiRequestError
        ? cause.message
        : 'Каталог временно недоступен. Попробуйте обновить страницу.';
  }
  const value = (key: string) => (typeof search[key] === 'string' ? search[key] : '');
  return (
    <main>
      <a className="brand" href="/">
        EventFlow<span aria-hidden="true">↗</span>
      </a>
      <Account />
      <section aria-labelledby="headline">
        <p className="eyebrow">Место для новых впечатлений</p>
        <h1 id="headline">
          Хорошие события
          <br />
          начинаются здесь.
        </h1>
        <p className="intro">Концерты, встречи и открытия. Выбирайте то, что близко вам.</p>
        <form action="/" method="get" className="catalog-filters" aria-label="Фильтры мероприятий">
          <label>
            Название
            <input
              name="q"
              type="search"
              maxLength={160}
              defaultValue={value('q')}
              placeholder="Что ищем?"
            />
          </label>
          <label>
            Город
            <input
              name="city"
              maxLength={100}
              defaultValue={value('city')}
              placeholder="Все города"
            />
          </label>
          <label>
            С даты
            <input name="from" type="date" defaultValue={value('from')} />
          </label>
          <label>
            По дату
            <input name="to" type="date" defaultValue={value('to')} />
          </label>
          <button type="submit">Найти события</button>
        </form>
        <p className="filter-hint">Даты указаны по местному времени мероприятия.</p>
        {error && (
          <div role="alert" className="empty">
            {error} <a href="/">Сбросить фильтры</a>
          </div>
        )}
        {result && <EventList result={result} search={search} />}
      </section>
      <footer>EventFlow · События, которые объединяют</footer>
    </main>
  );
}
