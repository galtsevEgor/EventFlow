import { useState, type KeyboardEvent } from 'react';
import { Alert, Button, Field, Select } from '@eventflow/ui';
import { createGridMap, moveSeats, rotateSeats, VenueMapView } from '@eventflow/seat-map';
import { venueMapSchema, type VenueMap } from '@eventflow/event-contracts';
import {
  changeSeats,
  editorSeats,
  emptyHistory,
  remember,
  travel,
  type Category,
  type Layout,
} from './model';
import { MapDimensions, VenueFeatures } from './features';

export function VenueEditor({
  layout,
  categories,
  onChange,
}: {
  layout: Layout;
  categories: Category[];
  onChange: (layout: Layout) => void;
}) {
  const map = layout.map!;
  const [selected, setSelected] = useState<string[]>([]),
    [history, setHistory] = useState(emptyHistory);
  const [error, setError] = useState(''),
    [tool, setTool] = useState<'pan' | 'select'>('select');
  const [category, setCategory] = useState(layout.defaultCategoryId),
    [row, setRow] = useState(1);
  const [rows, setRows] = useState(layout.rows),
    [columns, setColumns] = useState(layout.columns);
  function commit(next: Layout) {
    const parsed = venueMapSchema.safeParse(next.map);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Проверьте план зала.');
      return;
    }
    setHistory(remember(history, layout));
    onChange(next);
    setError('');
  }
  const changeMap = (next: VenueMap) => commit({ ...layout, map: next });
  function navigate(direction: 'undo' | 'redo') {
    const result = travel(history, layout, direction);
    if (!result) return;
    setHistory(result.history);
    onChange(result.value);
    setError('');
  }
  function select(id: string, additive: boolean) {
    setSelected((current) =>
      additive
        ? current.includes(id)
          ? current.filter((value) => value !== id)
          : [...current, id]
        : [id],
    );
  }
  function keyboard(event: KeyboardEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest('input,select,textarea,[contenteditable]')) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      navigate(event.shiftKey ? 'redo' : 'undo');
    }
    if (event.key === 'Escape') setSelected([]);
  }
  const validGrid =
    Number.isInteger(rows) &&
    Number.isInteger(columns) &&
    rows > 0 &&
    columns > 0 &&
    rows <= 50 &&
    columns <= 50 &&
    rows * columns <= 1000;
  return (
    <section className="venue-editor" onKeyDown={keyboard} aria-label="Конструктор зала">
      <p className="muted">
        Выделите места щелчком или рамкой. Shift добавляет места к выделению. Перетащите группу или
        используйте кнопки. Правки сохраняются кнопкой «Сохранить настройки».
      </p>
      <div className="grid-tools">
        <Button type="button" disabled={!history.past.length} onClick={() => navigate('undo')}>
          Отменить действие
        </Button>
        <Button type="button" disabled={!history.future.length} onClick={() => navigate('redo')}>
          Повторить действие
        </Button>
        <Select
          label="Инструмент плана"
          value={tool}
          onChange={(e) => setTool(e.target.value as 'pan' | 'select')}
        >
          <option value="select">Выбор и перемещение мест</option>
          <option value="pan">Перемещение плана</option>
        </Select>
        <Button type="button" onClick={() => setSelected(map.seats.map((s) => s.seatId))}>
          Выделить все
        </Button>
        <Button type="button" onClick={() => setSelected([])}>
          Снять выделение
        </Button>
      </div>
      <div className="grid-tools">
        <Field
          label="Выбираемый ряд"
          type="number"
          min={1}
          max={layout.rows}
          value={row}
          onChange={(e) => setRow(Number(e.target.value))}
        />
        <Button
          type="button"
          onClick={() =>
            setSelected(
              map.seats.filter((s) => s.seatId.startsWith(`r${row}-`)).map((s) => s.seatId),
            )
          }
        >
          Выбрать ряд
        </Button>
      </div>
      <p role="status">Выделено мест: {selected.length}</p>
      {error && <Alert>{error}</Alert>}
      <VenueMapView
        map={map}
        seats={editorSeats(layout, categories)}
        selectedIds={selected}
        onSelect={select}
        edit
        tool={tool}
        onMove={(ids, dx, dy) => changeMap(moveSeats(map, ids, dx, dy))}
        onBoxSelect={(ids, additive) =>
          setSelected((current) => (additive ? [...new Set([...current, ...ids])] : ids))
        }
      />
      <fieldset disabled={!selected.length} className="configuration-section">
        <legend>Выделенные места</legend>
        <div className="grid-tools">
          {(
            [
              [-10, 0, 'Сдвинуть влево'],
              [10, 0, 'Сдвинуть вправо'],
              [0, -10, 'Сдвинуть вверх'],
              [0, 10, 'Сдвинуть вниз'],
            ] as const
          ).map(([dx, dy, label]) => (
            <Button
              key={label}
              type="button"
              onClick={() => changeMap(moveSeats(map, selected, dx, dy))}
            >
              {label}
            </Button>
          ))}
          <Button type="button" onClick={() => changeMap(rotateSeats(map, selected, -15))}>
            Повернуть −15°
          </Button>
          <Button type="button" onClick={() => changeMap(rotateSeats(map, selected, 15))}>
            Повернуть +15°
          </Button>
        </div>
        <div className="grid-tools">
          <Select
            label="Категория выделенных мест"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <Button
            type="button"
            onClick={() => commit(changeSeats(layout, selected, { categoryId: category }))}
          >
            Назначить категорию группе
          </Button>
          <Button
            type="button"
            onClick={() => commit(changeSeats(layout, selected, { disabled: true }))}
          >
            Отключить места
          </Button>
          <Button
            type="button"
            onClick={() => commit(changeSeats(layout, selected, { disabled: false }))}
          >
            Включить места
          </Button>
        </div>
      </fieldset>
      <MapDimensions key={`${map.width}:${map.height}`} map={map} onChange={changeMap} />
      <VenueFeatures map={map} onChange={changeMap} />
      <fieldset className="configuration-section">
        <legend>Построить ряды заново</legend>
        <p className="muted">
          Заменяет расположение и объекты плана. Категории сохранённых мест остаются. Действие можно
          отменить.
        </p>
        <div className="grid-tools">
          <Field
            label="Рядов в новом плане"
            type="number"
            min={1}
            max={50}
            value={rows}
            onChange={(e) => setRows(Number(e.target.value))}
          />
          <Field
            label="Мест в новом ряду"
            type="number"
            min={1}
            max={50}
            value={columns}
            onChange={(e) => setColumns(Number(e.target.value))}
          />
          <Button
            type="button"
            disabled={!validGrid}
            onClick={() => {
              commit({
                ...layout,
                rows,
                columns,
                map: createGridMap(rows, columns),
                overrides: layout.overrides.filter((s) => s.row <= rows && s.number <= columns),
              });
              setSelected([]);
            }}
          >
            Построить ряды
          </Button>
        </div>
        {!validGrid && <p role="alert">От 1 до 50 рядов и мест, суммарно не более 1 000.</p>}
      </fieldset>
    </section>
  );
}
