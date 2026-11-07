import { expect, it } from 'vitest';
import { createGridMap } from '@eventflow/seat-map';
import {
  changeSeats,
  emptyHistory,
  remember,
  travel,
  editorSeats,
  type Layout,
} from '../src/venue/model';

const layout = (): Layout => ({
  rows: 2,
  columns: 3,
  defaultCategoryId: 'standard',
  overrides: [],
  map: createGridMap(2, 3),
});
it('undo and redo restore exact geometry and category changes; a new branch discards redo', () => {
  const original = layout(),
    changed = changeSeats(original, ['r1-s1'], { disabled: true });
  const undo = travel(remember(emptyHistory(), original), changed, 'undo')!;
  expect(undo.value).toEqual(original);
  const redo = travel(undo.history, original, 'redo')!;
  expect(redo.value).toEqual(changed);
  expect(travel(remember(undo.history, original), changed, 'redo')).toBeNull();
  expect(original.overrides).toEqual([]);
});
it('mass operations keep disabled state, stable IDs and other rows; obsolete IDs cannot create seats', () => {
  const original = changeSeats(layout(), ['r1-s1'], { disabled: true });
  const changed = changeSeats(original, ['r1-s1', 'r1-s2', 'r3-s1'], { categoryId: 'vip' });
  expect(changed.overrides).toHaveLength(2);
  expect(changed.overrides[0]).toMatchObject({
    row: 1,
    number: 1,
    categoryId: 'vip',
    disabled: true,
  });
  const seats = editorSeats(changed, [
    { id: 'standard', name: 'Партер', price: '15.00' },
    { id: 'vip', name: 'Балкон', price: '29,90' },
  ]);
  expect(seats[0]).toMatchObject({ seatId: 'r1-s1', state: 'DISABLED', priceMinor: 2990 });
  expect(seats[3]).toMatchObject({ seatId: 'r2-s1', categoryId: 'standard', priceMinor: 1500 });
});
it('retains a bounded thirty-step history for a thousand-seat plan', () => {
  const value = { ...layout(), rows: 20, columns: 50, map: createGridMap(20, 50) };
  let history = emptyHistory();
  for (let i = 0; i < 60; i++) history = remember(history, value);
  expect(history.past).toHaveLength(30);
  expect(history.past[0]!.map!.seats).toHaveLength(1000);
});
