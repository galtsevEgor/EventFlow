import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

function App() {
  return (
    <main>
      <header>
        <strong>EventFlow</strong>
        <span>Кабинет организатора</span>
      </header>
      <section aria-labelledby="title">
        <p className="eyebrow">Ваше пространство</p>
        <h1 id="title">Мероприятия</h1>
        <div className="empty">
          <h2>Начните с вашей команды</h2>
          <p>Здесь будут события, продажи и участники вашей организации.</p>
        </div>
      </section>
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Application root is missing');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
