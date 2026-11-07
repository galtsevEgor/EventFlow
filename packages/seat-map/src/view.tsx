'use client';
import { useEffect, useRef, useState } from 'react';
import { attachAsync } from './lifecycle.js';
import { canSelect, categoryColor, describeSeat } from './presentation.js';
import type { MapRenderer } from './renderer.js';
import type { VenueMapViewProps } from './types.js';

const PAGE_SIZE = 50;
const toolbarStyle = { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' as const };

export function VenueMapView(props: VenueMapViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const renderer = useRef<MapRenderer | undefined>(undefined);
  const latest = useRef(props);
  latest.current = props;
  const [fallback, setFallback] = useState(false);
  const [ready, setReady] = useState(false);
  const [showList, setShowList] = useState(false);
  const [tooltip, setTooltip] = useState('');
  const [page, setPage] = useState(0);
  useEffect(() => {
    const element = host.current;
    if (!element || fallback) return;
    const detach = attachAsync(
      async (signal) => {
        const module = await import('./renderer.js');
        if (signal.aborted) throw new Error('Unmounted');
        return module.createRenderer(
          element,
          latest.current,
          setTooltip,
          () => setFallback(true),
          signal,
        );
      },
      (value) => {
        renderer.current = value;
        value.update(latest.current);
        setReady(true);
      },
      () => {
        renderer.current = undefined;
        setFallback(true);
      },
    );
    return () => {
      detach();
      renderer.current = undefined;
    };
  }, [fallback]);
  useEffect(() => {
    renderer.current?.update(props);
  }, [
    props.map,
    props.seats,
    props.selectedIds,
    props.disabledIds,
    props.disabled,
    props.edit,
    props.tool,
    props.onSelect,
    props.onMove,
    props.onBoxSelect,
    props.currency,
  ]);
  const ids = new Set(props.map.seats.map((seat) => seat.seatId));
  const seats = props.seats.filter((seat) => ids.has(seat.seatId));
  const categories = [
    ...new Map(
      seats.map((seat) => [seat.categoryId, { id: seat.categoryId, name: seat.categoryName }]),
    ).values(),
  ];
  const pageCount = Math.max(1, Math.ceil(seats.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const listVisible = fallback || showList;
  return (
    <section
      aria-label={props.edit ? 'Редактор плана зала' : 'Выбор мест в зале'}
      style={{ minWidth: 0, width: '100%' }}
    >
      <div style={toolbarStyle}>
        <button
          type="button"
          aria-label="Увеличить план"
          disabled={fallback || !ready || showList}
          onClick={() => renderer.current?.zoom(1.25)}
        >
          +
        </button>
        <button
          type="button"
          aria-label="Уменьшить план"
          disabled={fallback || !ready || showList}
          onClick={() => renderer.current?.zoom(0.8)}
        >
          −
        </button>
        <button
          type="button"
          disabled={fallback || !ready || showList}
          onClick={() => renderer.current?.fit()}
        >
          Показать весь зал
        </button>
        <button
          type="button"
          aria-pressed={listVisible}
          disabled={fallback}
          onClick={() => setShowList((value) => !value)}
        >
          {listVisible ? 'План зала' : 'Список мест'}
        </button>
      </div>
      {fallback && <p role="status">Графический план недоступен. Выберите места в списке.</p>}
      {!fallback && !ready && <p role="status">Загрузка плана…</p>}
      <div
        ref={host}
        aria-label="План зала. Для выбора с клавиатуры откройте список мест."
        style={{
          height: 'clamp(280px,55vh,580px)',
          width: '100%',
          display: listVisible ? 'none' : 'block',
          touchAction: 'none',
          overflow: 'hidden',
          border: '1px solid #cbd5e1',
          borderRadius: 8,
          marginTop: 8,
        }}
      />
      {!listVisible && (
        <p style={{ minHeight: '1.5em', fontSize: 14, margin: '6px 0' }}>
          {tooltip ||
            'Нажмите на место для выбора. Колесо или два пальца — масштаб; перетаскивание — перемещение.'}
        </p>
      )}
      {listVisible && (
        <div aria-label="Доступные места" style={{ marginTop: 12 }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 240px), 1fr))',
              gap: 8,
            }}
          >
            {seats.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map((seat) => (
              <button
                key={seat.seatId}
                type="button"
                aria-pressed={props.selectedIds.includes(seat.seatId)}
                disabled={!canSelect(seat, props)}
                onClick={(event) =>
                  props.onSelect(
                    seat.seatId,
                    props.edit ? event.shiftKey || event.ctrlKey || event.metaKey : true,
                  )
                }
                style={{
                  textAlign: 'left',
                  padding: 10,
                  borderRadius: 6,
                  border: props.selectedIds.includes(seat.seatId)
                    ? '3px solid #0f172a'
                    : '1px solid #94a3b8',
                }}
              >
                {describeSeat(seat, props.currency)}
              </button>
            ))}
          </div>
          <nav aria-label="Страницы мест" style={{ ...toolbarStyle, marginTop: 12 }}>
            <button
              type="button"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              Предыдущие места
            </button>
            <span>
              Страница {currentPage + 1} из {pageCount}
            </span>
            <button
              type="button"
              disabled={currentPage + 1 >= pageCount}
              onClick={() => setPage(currentPage + 1)}
            >
              Следующие места
            </button>
          </nav>
        </div>
      )}
      <ul
        aria-label="Легенда плана"
        style={{
          display: 'flex',
          gap: 16,
          flexWrap: 'wrap',
          listStyle: 'none',
          padding: 0,
          fontSize: 14,
        }}
      >
        {categories.map((category) => (
          <li key={category.id}>
            <span
              aria-hidden="true"
              style={{
                display: 'inline-block',
                width: 12,
                height: 12,
                borderRadius: '50%',
                marginRight: 5,
                background: `#${categoryColor(category.id).toString(16).padStart(6, '0')}`,
              }}
            />
            {category.name}
          </li>
        ))}
        <li>◌ Выбрано (обводка)</li>
        <li>● Забронировано (жёлтое)</li>
        <li>× Продано / недоступно</li>
      </ul>
    </section>
  );
}
