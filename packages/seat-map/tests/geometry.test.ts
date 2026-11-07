import { describe, expect, it } from 'vitest';
import { venueMapSchema } from '@eventflow/event-contracts';
import {
  createGridMap,
  fitViewport,
  hitSeat,
  moveSeats,
  rotateSeats,
  screenToWorld,
  seatsInRect,
  worldToScreen,
  zoomViewport,
} from '../src/geometry.js';

describe('venue map geometry', () => {
  it('generates valid stable grids at the 1000-seat limit without stage collisions', () => {
    const map = createGridMap(20, 50);
    expect(venueMapSchema.safeParse(map).success).toBe(true);
    expect(map.seats).toHaveLength(1000);
    expect(map.seats[0]?.seatId).toBe('r1-s1');
    expect(map.seats[999]?.seatId).toBe('r20-s50');
    expect(createGridMap(1, 1).seats[0]?.seatId).toBe('r1-s1');
    expect(venueMapSchema.safeParse(createGridMap(1, 1)).success).toBe(true);
    expect(() => createGridMap(21, 50)).toThrow(RangeError);
    expect(() => createGridMap(0, 4)).toThrow(RangeError);
    expect(() => createGridMap(1, 100)).toThrow(RangeError);
    expect(() => createGridMap(51, 1)).toThrow(RangeError);
    expect(() => createGridMap(1, 51)).toThrow(RangeError);
    expect(() => createGridMap(1.5, 4)).toThrow(RangeError);
  });
  it('snaps a common delta and preserves offsets at edges without mutating input', () => {
    const map = createGridMap(2, 3),
      original = structuredClone(map);
    const moved = moveSeats(map, ['r1-s1', 'r1-s2'], 16, 24);
    expect(moved.seats[0]?.x).toBe(map.seats[0]!.x + 20);
    expect(moved.seats[1]?.y).toBe(map.seats[1]!.y + 20);
    expect(moved.seats[2]).toBe(map.seats[2]);
    const clipped = moveSeats(map, ['r1-s1', 'r1-s2'], -10000, -10000);
    expect(clipped.seats[0]?.x).toBe(14);
    expect(clipped.seats[0]?.y).toBe(14);
    expect(clipped.seats[1]!.x - clipped.seats[0]!.x).toBe(40);
    expect(map).toEqual(original);
    expect(moveSeats(map, [], 20, 20)).toBe(map);
    expect(() => moveSeats(map, ['r1-s1'], NaN, 1)).toThrow(RangeError);
    expect(() => moveSeats(map, ['r1-s1'], 1, 1, -1)).toThrow(RangeError);
  });
  it('wraps chair orientation consistently and rotates groups without distorting spacing', () => {
    const map = createGridMap(1, 2);
    const result = rotateSeats(rotateSeats(map, ['r1-s1'], 170), ['r1-s1'], 30);
    expect(result.seats[0]).toEqual({ ...map.seats[0], rotation: -160 });
    expect(rotateSeats(result, ['r1-s1'], -580).seats[0]?.rotation).toBe(-20);
    expect(result.seats[1]).toBe(map.seats[1]);
    const group = rotateSeats(map, ['r1-s1', 'r1-s2'], 90);
    expect(group.seats[0]!.x).toBeCloseTo((map.seats[0]!.x + map.seats[1]!.x) / 2);
    expect(group.seats[0]!.y).toBeCloseTo(map.seats[0]!.y - 20);
    expect(group.seats[1]!.y).toBeCloseTo(map.seats[1]!.y + 20);
    expect(
      Math.hypot(group.seats[0]!.x - group.seats[1]!.x, group.seats[0]!.y - group.seats[1]!.y),
    ).toBeCloseTo(40);
    expect(group.seats.map((s) => s.seatId)).toEqual(map.seats.map((s) => s.seatId));
    expect(() => rotateSeats(map, [], Infinity)).toThrow(RangeError);
  });
  it('selects centres in world space in either rectangle direction and hit-tests seat radius', () => {
    const map = createGridMap(2, 3);
    const first = map.seats[0]!;
    expect(seatsInRect(map, { x: first.x, y: first.y, width: 40, height: 0 })).toEqual([
      'r1-s1',
      'r1-s2',
    ]);
    expect(seatsInRect(map, { x: first.x + 40, y: first.y + 40, width: -40, height: -40 })).toEqual(
      ['r1-s1', 'r1-s2', 'r2-s1', 'r2-s2'],
    );
    expect(hitSeat(map, { x: first.x + 14, y: first.y })).toBe(first.seatId);
    expect(hitSeat(map, { x: first.x + 15, y: first.y })).toBeUndefined();
  });
  it('fits inside the viewport, round-trips coordinates and zooms around the anchor', () => {
    const map = createGridMap(20, 50),
      view = fitViewport(map, 800, 400);
    const start = worldToScreen({ x: 0, y: 0 }, view),
      end = worldToScreen({ x: map.width, y: map.height }, view);
    expect(start.x).toBeGreaterThanOrEqual(20);
    expect(start.y).toBeGreaterThanOrEqual(20);
    expect(end.x).toBeLessThanOrEqual(780);
    expect(end.y).toBeLessThanOrEqual(380);
    const point = { x: 305, y: 205 },
      world = screenToWorld(point, view),
      zoomed = zoomViewport(view, 2, point);
    expect(worldToScreen(world, zoomed).x).toBeCloseTo(point.x);
    expect(worldToScreen(world, zoomed).y).toBeCloseTo(point.y);
    expect(screenToWorld(worldToScreen(world, view), view)).toEqual(world);
    expect(zoomViewport(view, 1e9, point).scale).toBe(6);
    expect(zoomViewport(view, 1e-9, point).scale).toBe(0.01);
  });
  it('fits extreme map sizes without reversing the direction of subsequent zoom', () => {
    const anchor = { x: 90, y: 140 };
    const small = fitViewport({ width: 10000, height: 10000 }, 180, 280);
    const large = fitViewport({ width: 200, height: 200 }, 5000, 5000);
    expect(zoomViewport(small, 0.8, anchor).scale).toBeLessThan(small.scale);
    expect(zoomViewport(large, 1.25, anchor).scale).toBeGreaterThanOrEqual(large.scale);
    expect(worldToScreen({ x: 10000, y: 10000 }, small).x).toBeLessThanOrEqual(160);
  });
});
