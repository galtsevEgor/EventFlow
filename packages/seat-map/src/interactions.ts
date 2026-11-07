import { hitSeat, normalizedRect, screenToWorld, seatsInRect, zoomViewport } from './geometry.js';
import { canSelect, describeSeat } from './presentation.js';
import type { SceneState } from './draw.js';
import type { Point } from './types.js';

type Gesture = {
  start: Point;
  last: Point;
  world: Point;
  kind: 'pan' | 'box' | 'move' | 'click';
  id?: string;
  ids: string[];
  additive: boolean;
  moved: boolean;
};
type Control = { get: () => SceneState; draw: () => void; hover: (label: string) => void };
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export function bindInteractions(host: HTMLElement, control: Control): () => void {
  const pointers = new Map<number, Point>();
  let gesture: Gesture | undefined;
  let pinched = false;
  const position = (event: MouseEvent): Point => {
    const rect = host.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const clearPreview = () => {
    const state = control.get();
    delete state.preview;
    delete state.box;
  };
  const down = (event: PointerEvent) => {
    if (event.button !== 0) return;
    const point = position(event),
      state = control.get(),
      props = state.props;
    host.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId, point);
    if (pointers.size > 1) {
      pinched = true;
      gesture = undefined;
      clearPreview();
      control.draw();
      return;
    }
    pinched = false;
    const world = screenToWorld(point, state.view);
    const hit = hitSeat(props.map, world);
    const seat = props.seats.find((s) => s.seatId === hit);
    const id = seat && canSelect(seat, props) ? hit : undefined;
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    const kind =
      props.tool === 'pan'
        ? 'pan'
        : id
          ? props.edit && props.onMove
            ? 'move'
            : 'click'
          : props.edit && props.onBoxSelect
            ? 'box'
            : 'pan';
    gesture = {
      start: point,
      last: point,
      world,
      kind,
      ids: id ? (props.selectedIds.includes(id) ? [...props.selectedIds] : [id]) : [],
      additive,
      moved: false,
      ...(id ? { id } : {}),
    };
  };
  const move = (event: PointerEvent) => {
    const point = position(event),
      state = control.get();
    const old = pointers.get(event.pointerId);
    if (old && pointers.size >= 2) {
      const other = [...pointers].find(([id]) => id !== event.pointerId)?.[1];
      pointers.set(event.pointerId, point);
      if (other) {
        const before = midpoint(old, other),
          after = midpoint(point, other);
        state.view = zoomViewport(
          state.view,
          distance(point, other) / Math.max(1, distance(old, other)),
          before,
        );
        state.view.x += after.x - before.x;
        state.view.y += after.y - before.y;
        control.draw();
      }
      return;
    }
    if (old) pointers.set(event.pointerId, point);
    if (gesture && old && !pinched) {
      gesture.moved ||= distance(point, gesture.start) > 4;
      const world = screenToWorld(point, state.view);
      if (gesture.kind === 'pan') {
        state.view = {
          ...state.view,
          x: state.view.x + point.x - gesture.last.x,
          y: state.view.y + point.y - gesture.last.y,
        };
      } else if (gesture.moved && gesture.kind === 'move') {
        state.preview = {
          ids: gesture.ids,
          delta: { x: world.x - gesture.world.x, y: world.y - gesture.world.y },
        };
      } else if (gesture.moved && gesture.kind === 'box')
        state.box = normalizedRect(gesture.world, world);
      gesture.last = point;
      control.draw();
      return;
    }
    const id = hitSeat(state.props.map, screenToWorld(point, state.view));
    const seat = state.props.seats.find((s) => s.seatId === id);
    control.hover(seat ? describeSeat(seat, state.props.currency) : '');
  };
  const up = (event: PointerEvent) => {
    const state = control.get(),
      props = state.props;
    pointers.delete(event.pointerId);
    if (!pinched && gesture) {
      if (gesture.moved && gesture.kind === 'move' && state.preview && !props.disabled) {
        if (gesture.id && !props.selectedIds.includes(gesture.id))
          props.onSelect(gesture.id, gesture.additive);
        props.onMove?.(gesture.ids, state.preview.delta.x, state.preview.delta.y);
      } else if (gesture.moved && gesture.kind === 'box' && state.box && !props.disabled) {
        props.onBoxSelect?.(seatsInRect(props.map, state.box), gesture.additive);
      } else if (!gesture.moved && gesture.id && gesture.kind !== 'pan') {
        const seat = props.seats.find((s) => s.seatId === gesture!.id);
        if (seat && canSelect(seat, props)) props.onSelect(gesture.id, gesture.additive);
      }
    }
    gesture = undefined;
    clearPreview();
    control.draw();
    if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
  };
  const cancel = (event: PointerEvent) => {
    pointers.delete(event.pointerId);
    gesture = undefined;
    clearPreview();
    control.draw();
  };
  const wheel = (event: WheelEvent) => {
    event.preventDefault();
    const state = control.get();
    state.view = zoomViewport(
      state.view,
      Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * 0.008),
      position(event),
    );
    control.draw();
  };
  const leave = () => control.hover('');
  host.addEventListener('pointerdown', down);
  host.addEventListener('pointermove', move);
  host.addEventListener('pointerup', up);
  host.addEventListener('pointercancel', cancel);
  host.addEventListener('pointerleave', leave);
  host.addEventListener('wheel', wheel, { passive: false });
  return () => {
    host.removeEventListener('pointerdown', down);
    host.removeEventListener('pointermove', move);
    host.removeEventListener('pointerup', up);
    host.removeEventListener('pointercancel', cancel);
    host.removeEventListener('pointerleave', leave);
    host.removeEventListener('wheel', wheel);
    for (const id of pointers.keys())
      if (host.hasPointerCapture(id)) host.releasePointerCapture(id);
    pointers.clear();
  };
}
