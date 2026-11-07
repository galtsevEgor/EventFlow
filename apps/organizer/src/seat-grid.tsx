import { useState } from 'react';
import { Field, Select } from '@eventflow/ui';
import type { Schemas } from './api';
import { createGridMap } from '@eventflow/seat-map';
import { VenueEditor } from './venue/editor';

type Layout = Schemas['EventConfiguration']['layout'];
type Category = { id: string; name: string; price: string };
export function SeatGrid({
  layout,
  categories,
  onChange,
  disabled = false,
}: {
  layout: Layout;
  categories: Category[];
  onChange: (layout: Layout) => void;
  disabled?: boolean;
}) {
  const [mode, setMode] = useState('category');
  const [visual, setVisual] = useState(Boolean(layout.map));
  const [categoryId, setCategoryId] = useState(layout.defaultCategoryId);
  const overrides = new Map(layout.overrides.map((seat) => [`${seat.row}:${seat.number}`, seat]));
  const validSize =
    Number.isInteger(layout.rows) &&
    Number.isInteger(layout.columns) &&
    layout.rows > 0 &&
    layout.columns > 0 &&
    layout.rows <= 50 &&
    layout.columns <= 50 &&
    layout.rows * layout.columns <= 1000;
  function resize(rows: number, columns: number) {
    onChange({
      ...layout,
      rows,
      columns,
      overrides: layout.overrides.filter((seat) => seat.row <= rows && seat.number <= columns),
    });
  }
  function changeSeat(row: number, number: number) {
    const previous = overrides.get(`${row}:${number}`) ?? {
      row,
      number,
      categoryId: layout.defaultCategoryId,
      disabled: false,
    };
    const selected = categories.some((category) => category.id === categoryId)
      ? categoryId
      : layout.defaultCategoryId;
    const seat =
      mode === 'availability'
        ? { ...previous, disabled: !previous.disabled }
        : { ...previous, categoryId: selected };
    onChange({
      ...layout,
      overrides: [
        ...layout.overrides.filter((item) => item.row !== row || item.number !== number),
        seat,
      ],
    });
  }
  return (
    <fieldset className="configuration-section">
      <legend>Схема мест</legend>
      <button
        type="button"
        onClick={() => {
          if (!visual && !layout.map && validSize)
            onChange({ ...layout, map: createGridMap(layout.rows, layout.columns) });
          setVisual(!visual);
        }}
        disabled={!validSize}
      >
        {visual ? 'Открыть сетку мест' : 'Открыть конструктор зала'}
      </button>
      {visual && layout.map ? (
        <VenueEditor
          key={categories.map((category) => category.id).join(',')}
          layout={layout}
          categories={categories}
          onChange={onChange}
          disabled={disabled}
        />
      ) : (
        <>
          <div className="grid-tools">
            <Field
              label="Рядов"
              type="number"
              min={1}
              max={50}
              required
              disabled={Boolean(layout.map)}
              value={layout.rows}
              onChange={(event) => resize(Number(event.target.value), layout.columns)}
            />
            <Field
              label="Мест в ряду"
              type="number"
              min={1}
              max={50}
              required
              disabled={Boolean(layout.map)}
              value={layout.columns}
              onChange={(event) => resize(layout.rows, Number(event.target.value))}
            />
            <Select
              label="Категория по умолчанию"
              value={layout.defaultCategoryId}
              onChange={(event) => onChange({ ...layout, defaultCategoryId: event.target.value })}
            >
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </Select>
          </div>
          <p className="muted">
            До 1 000 мест. Выберите действие, затем нажмите на место. Кнопки доступны с клавиатуры;
            × означает отключённое место.
          </p>
          {layout.map && (
            <p className="muted">Размеры и расположение меняются в конструкторе зала.</p>
          )}
          <div className="grid-tools">
            <Select
              label="Действие с местом"
              value={mode}
              onChange={(event) => setMode(event.target.value)}
            >
              <option value="category">Назначить категорию</option>
              <option value="availability">Включить или отключить</option>
            </Select>
            {mode === 'category' && (
              <Select
                label="Назначаемая категория"
                value={
                  categories.some((category) => category.id === categoryId)
                    ? categoryId
                    : layout.defaultCategoryId
                }
                onChange={(event) => setCategoryId(event.target.value)}
              >
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </Select>
            )}
          </div>
          {!validSize ? (
            <p role="alert">
              Укажите от 1 до 50 рядов и мест в ряду, суммарно не более 1 000 мест.
            </p>
          ) : (
            <div
              className="seat-scroll"
              role="region"
              aria-label="Редактор схемы мест"
              tabIndex={0}
            >
              <div
                className="seat-editor"
                style={{ gridTemplateColumns: `repeat(${layout.columns}, 42px)` }}
              >
                {Array.from({ length: layout.rows * layout.columns }, (_, index) => {
                  const row = Math.floor(index / layout.columns) + 1,
                    number = (index % layout.columns) + 1;
                  const change = overrides.get(`${row}:${number}`);
                  const selectedCategory = change?.categoryId ?? layout.defaultCategoryId;
                  const categoryIndex = categories.findIndex(
                    (category) => category.id === selectedCategory,
                  );
                  const name = categories[categoryIndex]?.name ?? 'Без категории';
                  return (
                    <button
                      type="button"
                      className={`seat-cell tone-${Math.max(categoryIndex, 0) % 4}`}
                      key={`${row}:${number}`}
                      aria-pressed={Boolean(change?.disabled)}
                      aria-label={`Ряд ${row}, место ${number}, ${name}${change?.disabled ? ', отключено' : ''}`}
                      title={`Ряд ${row}, место ${number} · ${name}`}
                      onClick={() => changeSeat(row, number)}
                    >
                      {change?.disabled ? '×' : `${row}.${number}`}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <p role="status" className="muted">
            Активных мест:{' '}
            {Math.max(
              0,
              layout.rows * layout.columns -
                layout.overrides.filter((seat) => seat.disabled).length,
            )}
          </p>
        </>
      )}
    </fieldset>
  );
}
