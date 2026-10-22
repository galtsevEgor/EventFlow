import { Account } from './account';
import type { Metadata } from 'next';
import { ApiRequestError, type Schemas } from '@eventflow/api-client';
import { listEvents, type Search } from './catalog-api';
import { EventList } from './event-list';
import { searchEvents, SearchInputError } from './search-api';
import { SearchBox } from './search-box';

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
  const enhanced = process.env.SEARCH_ENABLED === 'true';
  let result: Schemas['PublicEventPage'] | undefined;
  let searchProof: string | undefined;
  let facets: Schemas['SearchPage']['facets'] | undefined;
  let limited = false,
    error = '';
  try {
    if (enhanced) {
      const page = await searchEvents(search);
      result = page;
      searchProof = page.searchProof;
      facets = page.facets;
      limited = page.limited;
    } else result = await listEvents(search);
  } catch (cause) {
    error =
      cause instanceof SearchInputError ||
      (cause instanceof ApiRequestError && !cause.problem.retryable)
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
        <form
          action="/"
          method="get"
          className={'catalog-filters' + (enhanced ? ' enhanced-filters' : '')}
          aria-label="Фильтры мероприятий"
        >
          {enhanced ? (
            <SearchBox initialValue={value('q')} key={value('q')} />
          ) : (
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
          )}
          <label>
            Город
            <input
              name="city"
              maxLength={100}
              defaultValue={value('city')}
              placeholder="Все города"
              list={enhanced ? 'search-cities' : undefined}
            />
            {facets && (
              <datalist id="search-cities">
                {facets.cities.map((city) => (
                  <option key={city.value} value={city.value}>
                    {city.count} событий
                  </option>
                ))}
              </datalist>
            )}
          </label>
          <label>
            С даты
            <input name="from" type="date" defaultValue={value('from')} />
          </label>
          <label>
            По дату
            <input name="to" type="date" defaultValue={value('to')} />
          </label>
          {enhanced && (
            <>
              <label>
                Цена от, €
                <input
                  name="minPrice"
                  type="number"
                  min="0"
                  max="1000000"
                  step="0.01"
                  defaultValue={value('minPrice')}
                  placeholder="Любая"
                />
              </label>
              <label>
                Цена до, €
                <input
                  name="maxPrice"
                  type="number"
                  min="0"
                  max="1000000"
                  step="0.01"
                  defaultValue={value('maxPrice')}
                  placeholder="Любая"
                />
              </label>
              <label>
                Сортировка
                <select
                  name="sort"
                  defaultValue={value('sort') || (value('q') ? 'relevance' : 'date')}
                >
                  <option value="relevance">По соответствию</option>
                  <option value="date">По дате</option>
                  <option value="price_asc">Сначала дешевле</option>
                  <option value="price_desc">Сначала дороже</option>
                </select>
              </label>
            </>
          )}
          <button type="submit">Найти события</button>
        </form>
        <p className="filter-hint">Даты указаны по местному времени мероприятия.</p>
        {limited && (
          <p role="status" className="search-notice">
            Сейчас доступен упрощённый поиск по названию и описанию. Фильтры продолжают работать.
          </p>
        )}
        {error && (
          <div role="alert" className="empty">
            {error} <a href="/">Сбросить фильтры</a>
          </div>
        )}
        {result && <EventList result={result} search={search} searchProof={searchProof} />}
      </section>
      <footer>EventFlow · События, которые объединяют</footer>
    </main>
  );
}
