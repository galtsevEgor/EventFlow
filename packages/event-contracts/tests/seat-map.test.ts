import { describe, expect, it } from 'vitest';
import { venueMapSchema, type VenueMap } from '../src/seat-map';

const map = (): VenueMap => ({
  version: 1,
  width: 400,
  height: 300,
  seats: [
    { seatId: 'r1-s1', x: 80, y: 140, rotation: 0 },
    { seatId: 'r1-s2', x: 120, y: 140, rotation: 0 },
  ],
  features: [{ id: 'stage', kind: 'stage', label: 'Сцена', x: 80, y: 20, width: 200, height: 60 }],
});
describe('venue map transport validation', () => {
  it('accepts stable identities and touching seat boundaries', () => {
    const value = map();
    value.seats[1]!.x = 108;
    expect(venueMapSchema.parse(value)).toEqual(value);
  });
  it.each([
    'duplicate',
    'overlap',
    'boundary',
    'nonfinite',
    'feature',
    'feature-id',
    'stage-overlap',
    'version',
    'too-many',
  ])('rejects %s before persisting geometry', (kind) => {
    const value = map();
    if (kind === 'duplicate') value.seats[1]!.seatId = 'r1-s1';
    if (kind === 'overlap') value.seats[1]!.x = 90;
    if (kind === 'boundary') value.seats[0]!.x = 2;
    if (kind === 'nonfinite') value.seats[0]!.x = NaN;
    if (kind === 'feature') value.features[0]!.width = 400;
    if (kind === 'feature-id') value.features.push({ ...value.features[0]! });
    if (kind === 'stage-overlap') value.features[0]!.y = 130;
    if (kind === 'version') Object.assign(value, { version: 2 });
    if (kind === 'too-many') value.seats = Array.from({ length: 1001 }, () => value.seats[0]!);
    expect(venueMapSchema.safeParse(value).success).toBe(false);
  });
  it('permits a sector containing seats; labels are plain text', () => {
    const value = map();
    value.features.push({
      id: 'sector',
      kind: 'sector',
      label: 'Партер',
      x: 20,
      y: 110,
      width: 200,
      height: 100,
    });
    expect(venueMapSchema.safeParse(value).success).toBe(true);
  });
});
