import type { Schemas } from '../api';
import type { MapSeat } from '@eventflow/seat-map';

export type Layout = Schemas['EventConfiguration']['layout'];
export type Category = { id: string; name: string; price: string };
export type History = { past: Layout[]; future: Layout[] };
export const emptyHistory = (): History => ({ past: [], future: [] });
export function remember(history: History, current: Layout): History {
  return { past: [...history.past.slice(-29), current], future: [] };
}
export function travel(history: History, current: Layout, direction: 'undo' | 'redo') {
  const source = direction === 'undo' ? history.past : history.future;
  const value = source.at(-1);
  if (!value) return null;
  return {
    value,
    history:
      direction === 'undo'
        ? { past: source.slice(0, -1), future: [...history.future, current] }
        : { past: [...history.past, current], future: source.slice(0, -1) },
  };
}
export function changeSeats(
  layout: Layout,
  ids: string[],
  patch: { categoryId?: string; disabled?: boolean },
): Layout {
  const changes = new Map(layout.overrides.map((seat) => [`r${seat.row}-s${seat.number}`, seat]));
  for (const id of ids) {
    const match = /^r(\d+)-s(\d+)$/.exec(id);
    if (!match) continue;
    const row = Number(match[1]),
      number = Number(match[2]);
    if (row < 1 || row > layout.rows || number < 1 || number > layout.columns) continue;
    changes.set(id, {
      row,
      number,
      categoryId: layout.defaultCategoryId,
      disabled: false,
      ...changes.get(id),
      ...patch,
    });
  }
  return { ...layout, overrides: [...changes.values()] };
}
export function editorSeats(layout: Layout, categories: Category[]): MapSeat[] {
  const changes = new Map(layout.overrides.map((seat) => [`r${seat.row}-s${seat.number}`, seat]));
  return (layout.map?.seats ?? []).map((position) => {
    const change = changes.get(position.seatId);
    const [row, number] = position.seatId.slice(1).split('-s').map(Number);
    const categoryId = change?.categoryId ?? layout.defaultCategoryId;
    const category = categories.find((c) => c.id === categoryId);
    const price = Number(category?.price.replace(',', '.'));
    return {
      seatId: position.seatId,
      row: row!,
      number: number!,
      categoryId,
      categoryName: category?.name ?? 'Без категории',
      priceMinor: Number.isFinite(price) ? Math.round(price * 100) : 0,
      state: change?.disabled ? 'DISABLED' : 'AVAILABLE',
    };
  });
}
