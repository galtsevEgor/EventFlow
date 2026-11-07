import { seatRadius, type VenueMap } from '@eventflow/event-contracts';
import type { Point, Rect, Viewport } from './types.js';

const boundedScale = (scale: number) => Math.min(6, Math.max(0.01, scale));

export function createGridMap(rows: number, columns: number): VenueMap {
  if (
    !Number.isInteger(rows) ||
    !Number.isInteger(columns) ||
    rows < 1 ||
    columns < 1 ||
    rows > 50 ||
    columns > 50 ||
    rows * columns > 1000
  )
    throw new RangeError(
      'Зал должен содержать от 1 до 1000 мест; не более 50 рядов или мест в ряду.',
    );
  const width = Math.max(240, (columns - 1) * 40 + 100);
  return {
    version: 1,
    width,
    height: Math.max(240, (rows - 1) * 40 + 180),
    seats: Array.from({ length: rows * columns }, (_, i) => ({
      seatId: `r${Math.floor(i / columns) + 1}-s${(i % columns) + 1}`,
      x: (width - (columns - 1) * 40) / 2 + (i % columns) * 40,
      y: 130 + Math.floor(i / columns) * 40,
      rotation: 0,
    })),
    features: [
      { id: 'stage', kind: 'stage', label: 'Сцена', x: 30, y: 20, width: width - 60, height: 50 },
    ],
  };
}

/** Apply one shared snapped delta, preserving relative positions at map edges. */
export function moveSeats(
  map: VenueMap,
  ids: string[],
  dx: number,
  dy: number,
  snap = 10,
): VenueMap {
  if (![dx, dy, snap].every(Number.isFinite) || snap < 0)
    throw new RangeError('Некорректное перемещение.');
  const selected = new Set(ids);
  const seats = map.seats.filter((seat) => selected.has(seat.seatId));
  if (!seats.length) return map;
  const quantize = (value: number) => (snap ? Math.round(value / snap) * snap : value);
  const x = Math.max(
    seatRadius - Math.min(...seats.map((s) => s.x)),
    Math.min(quantize(dx), map.width - seatRadius - Math.max(...seats.map((s) => s.x))),
  );
  const y = Math.max(
    seatRadius - Math.min(...seats.map((s) => s.y)),
    Math.min(quantize(dy), map.height - seatRadius - Math.max(...seats.map((s) => s.y))),
  );
  return {
    ...map,
    seats: map.seats.map((seat) =>
      selected.has(seat.seatId) ? { ...seat, x: seat.x + x, y: seat.y + y } : seat,
    ),
  };
}

/** Rotate a group around its centroid; callers validate bounds/collisions before accepting. */
export function rotateSeats(map: VenueMap, ids: string[], degrees: number): VenueMap {
  if (!Number.isFinite(degrees)) throw new RangeError('Некорректный угол.');
  const selected = new Set(ids);
  const seats = map.seats.filter((seat) => selected.has(seat.seatId));
  if (!seats.length) return map;
  const centre = {
    x: seats.reduce((sum, seat) => sum + seat.x, 0) / seats.length,
    y: seats.reduce((sum, seat) => sum + seat.y, 0) / seats.length,
  };
  const radians = (degrees * Math.PI) / 180,
    cos = Math.cos(radians),
    sin = Math.sin(radians);
  return {
    ...map,
    seats: map.seats.map((seat) =>
      selected.has(seat.seatId)
        ? {
            ...seat,
            x: centre.x + (seat.x - centre.x) * cos - (seat.y - centre.y) * sin,
            y: centre.y + (seat.x - centre.x) * sin + (seat.y - centre.y) * cos,
            rotation: ((((seat.rotation + degrees + 180) % 360) + 360) % 360) - 180,
          }
        : seat,
    ),
  };
}

export function normalizedRect(start: Point, end: Point): Rect {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

/** Select seat centres, independent of the direction of the drag. */
export function seatsInRect(map: VenueMap, rect: Rect): string[] {
  const bounds = normalizedRect(rect, { x: rect.x + rect.width, y: rect.y + rect.height });
  return map.seats
    .filter(
      (s) =>
        s.x >= bounds.x &&
        s.x <= bounds.x + bounds.width &&
        s.y >= bounds.y &&
        s.y <= bounds.y + bounds.height,
    )
    .map((s) => s.seatId);
}

export function hitSeat(map: VenueMap, point: Point): string | undefined {
  return map.seats.find((s) => Math.hypot(s.x - point.x, s.y - point.y) <= seatRadius)?.seatId;
}

export function fitViewport(
  map: Pick<VenueMap, 'width' | 'height'>,
  width: number,
  height: number,
  padding = 20,
): Viewport {
  const scale = boundedScale(
    Math.min(
      Math.max(1, width - padding * 2) / map.width,
      Math.max(1, height - padding * 2) / map.height,
    ),
  );
  return { scale, x: (width - map.width * scale) / 2, y: (height - map.height * scale) / 2 };
}
export const screenToWorld = (point: Point, view: Viewport): Point => ({
  x: (point.x - view.x) / view.scale,
  y: (point.y - view.y) / view.scale,
});
export const worldToScreen = (point: Point, view: Viewport): Point => ({
  x: point.x * view.scale + view.x,
  y: point.y * view.scale + view.y,
});
export function zoomViewport(view: Viewport, factor: number, anchor: Point): Viewport {
  const scale = boundedScale(view.scale * factor);
  const world = screenToWorld(anchor, view);
  return { scale, x: anchor.x - world.x * scale, y: anchor.y - world.y * scale };
}
