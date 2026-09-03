import { Account } from './account';

export default function Home() {
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
        <div className="empty">
          <h2>Скоро здесь появятся мероприятия</h2>
          <p>Загляните позже за новыми впечатлениями.</p>
        </div>
      </section>
      <footer>EventFlow · События, которые объединяют</footer>
    </main>
  );
}
