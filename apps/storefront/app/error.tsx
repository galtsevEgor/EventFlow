'use client';
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main>
      <h1>Не удалось загрузить страницу</h1>
      <p>Попробуйте ещё раз через несколько секунд.</p>
      <button onClick={reset}>Повторить</button>
      <p>
        <a href="/">Вернуться в каталог</a>
      </p>
    </main>
  );
}
