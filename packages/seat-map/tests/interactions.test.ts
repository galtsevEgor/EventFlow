import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGridMap, screenToWorld } from '../src/geometry.js';
import { bindInteractions } from '../src/interactions.js';
import type { SceneState } from '../src/draw.js';

class Host extends EventTarget {
  captures = new Set<number>();
  getBoundingClientRect() {
    return { left: 0, top: 0 };
  }
  setPointerCapture(id: number) {
    this.captures.add(id);
  }
  hasPointerCapture(id: number) {
    return this.captures.has(id);
  }
  releasePointerCapture(id: number) {
    this.captures.delete(id);
  }
  pointer(type: string, x: number, y: number, options: Record<string, unknown> = {}) {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, {
      clientX: x,
      clientY: y,
      pointerId: 1,
      button: 0,
      shiftKey: false,
      ctrlKey: false,
      metaKey: false,
      ...options,
    });
    this.dispatchEvent(event);
    return event;
  }
}
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const run of cleanup.splice(0)) run();
});
function setup(edit = false) {
  const host = new Host(),
    map = createGridMap(2, 3),
    onSelect = vi.fn(),
    onMove = vi.fn(),
    onBoxSelect = vi.fn();
  const state: SceneState = {
    props: {
      map,
      seats: map.seats.map((seat, i) => ({
        seatId: seat.seatId,
        row: Math.floor(i / 3) + 1,
        number: (i % 3) + 1,
        categoryId: 'main',
        categoryName: 'Партер',
        priceMinor: 1500,
        state: 'AVAILABLE',
      })),
      selectedIds: [],
      onSelect,
      onMove,
      onBoxSelect,
      edit,
    },
    view: { x: 0, y: 0, scale: 1 },
  };
  cleanup.push(
    bindInteractions(host as unknown as HTMLElement, {
      get: () => state,
      draw: vi.fn(),
      hover: vi.fn(),
    }),
  );
  return { host, state, onSelect, onMove, onBoxSelect, first: map.seats[0]! };
}

describe('pointer interactions', () => {
  it('pans a buyer map from a seat without selecting it when the gesture becomes a drag', () => {
    const { host, state, onSelect, first } = setup();
    host.pointer('pointerdown', first.x, first.y);
    host.pointer('pointermove', first.x + 30, first.y + 20);
    host.pointer('pointerup', first.x + 30, first.y + 20);
    expect(state.view).toEqual({ x: 30, y: 20, scale: 1 });
    expect(onSelect).not.toHaveBeenCalled();
  });
  it('selects with additive modifiers and reads current availability and callbacks', () => {
    const { host, state, onSelect, first } = setup();
    host.pointer('pointerdown', first.x, first.y, { shiftKey: true });
    host.pointer('pointerup', first.x, first.y);
    expect(onSelect).toHaveBeenCalledWith(first.seatId, true);
    host.pointer('pointerdown', first.x, first.y);
    state.props = { ...state.props, disabled: true };
    host.pointer('pointerup', first.x, first.y);
    expect(onSelect).toHaveBeenCalledTimes(1);
    const latest = vi.fn();
    state.props = { ...state.props, disabled: false, onSelect: latest };
    host.pointer('pointerdown', first.x, first.y);
    host.pointer('pointerup', first.x, first.y);
    expect(latest).toHaveBeenCalledWith(first.seatId, false);
    expect(host.captures.size).toBe(0);
  });
  it('previews group dragging then emits exactly one world delta on release', () => {
    const { host, state, onMove, onSelect, first } = setup(true);
    state.view = { x: 10, y: 20, scale: 2 };
    state.props = { ...state.props, selectedIds: ['r1-s1', 'r1-s2'] };
    const x = first.x * 2 + 10,
      y = first.y * 2 + 20;
    host.pointer('pointerdown', x, y);
    host.pointer('pointermove', x + 40, y + 20);
    host.pointer('pointermove', x + 60, y + 30);
    expect(onMove).not.toHaveBeenCalled();
    expect(state.preview).toEqual({ ids: ['r1-s1', 'r1-s2'], delta: { x: 30, y: 15 } });
    host.pointer('pointerup', x + 60, y + 30);
    expect(onMove).toHaveBeenCalledExactlyOnceWith(['r1-s1', 'r1-s2'], 30, 15);
    expect(onSelect).not.toHaveBeenCalled();
    expect(state.preview).toBeUndefined();
  });
  it('cancels unfinished movement and box-selects in transformed world coordinates', () => {
    const { host, state, onMove, onBoxSelect, first } = setup(true);
    host.pointer('pointerdown', first.x, first.y);
    host.pointer('pointermove', first.x + 30, first.y + 20);
    host.pointer('pointercancel', first.x + 30, first.y + 20);
    expect(onMove).not.toHaveBeenCalled();
    expect(state.preview).toBeUndefined();
    state.view = { x: 10, y: 20, scale: 2 };
    host.pointer('pointerdown', (first.x - 20) * 2 + 10, (first.y - 20) * 2 + 20, {
      shiftKey: true,
    });
    host.pointer('pointermove', (first.x + 45) * 2 + 10, (first.y + 5) * 2 + 20);
    host.pointer('pointerup', (first.x + 45) * 2 + 10, (first.y + 5) * 2 + 20);
    expect(onBoxSelect).toHaveBeenCalledExactlyOnceWith(['r1-s1', 'r1-s2'], true);
  });
  it('pinches around the midpoint without clicking a seat and zooms wheel around its anchor', () => {
    const { host, state, onSelect, first } = setup();
    host.pointer('pointerdown', first.x, first.y);
    host.pointer('pointerdown', first.x + 100, first.y, { pointerId: 2 });
    host.pointer('pointermove', first.x + 200, first.y, { pointerId: 2 });
    expect(state.view.scale).toBeCloseTo(2);
    host.pointer('pointerup', first.x, first.y);
    host.pointer('pointerup', first.x + 200, first.y, { pointerId: 2 });
    expect(onSelect).not.toHaveBeenCalled();
    const anchor = { x: 100, y: 100 },
      before = screenToWorld(anchor, state.view);
    expect(host.pointer('wheel', anchor.x, anchor.y, { deltaY: -50 }).defaultPrevented).toBe(true);
    const after = screenToWorld(anchor, state.view);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });
  it('allows disabled chairs to be selected only in editor mode', () => {
    const { host, state, onSelect, first } = setup();
    state.props.seats[0]!.state = 'DISABLED';
    host.pointer('pointerdown', first.x, first.y);
    host.pointer('pointerup', first.x, first.y);
    expect(onSelect).not.toHaveBeenCalled();
    state.props = { ...state.props, edit: true };
    host.pointer('pointerdown', first.x, first.y);
    host.pointer('pointerup', first.x, first.y);
    expect(onSelect).toHaveBeenCalledWith(first.seatId, false);
  });
});
