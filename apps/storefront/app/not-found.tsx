import Link from 'next/link';
export default function NotFound() {
  return (
    <main>
      <h1>Мероприятие не найдено</h1>
      <p>Возможно, оно ещё не опубликовано.</p>
      <Link href="/">Вернуться в каталог</Link>
    </main>
  );
}
