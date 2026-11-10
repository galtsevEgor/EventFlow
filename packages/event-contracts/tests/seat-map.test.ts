import { describe, expect, it } from 'vitest';
import { venueMapSchema, venueSeatIdSchema, type VenueMap } from '../src/seat-map';

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
    expect(venueMapSchema.safeParse(value).success).toBe(false);
  });
  it('accepts all 1,000 distinct grid positions and rejects one additional valid position', () => {
    const value: VenueMap = {
      version: 1,
      width: 1_500,
      height: 630,
      seats: Array.from({ length: 1_000 }, (_, index) => {
        const row = Math.floor(index / 50) + 1;
        const number = (index % 50) + 1;
        return { seatId: `r${row}-s${number}`, x: number * 30 - 15, y: row * 30 - 15, rotation: 0 };
      }),
      features: [],
    };
    expect(venueMapSchema.parse(value).seats).toHaveLength(1_000);
    value.seats.push({ seatId: 'r21-s1', x: 15, y: 615, rotation: 0 });
    const result = venueMapSchema.safeParse(value);
    expect(result.error?.issues).toMatchObject([{ code: 'too_big', path: ['seats'] }]);
  });
  it('keeps canonical seat IDs at the row and column boundaries', () => {
    for (const seatId of ['r1-s1', 'r9-s10', 'r49-s49', 'r50-s50'])
      expect(venueSeatIdSchema.parse(seatId)).toBe(seatId);
    for (const seatId of ['r0-s1', 'r1-s0', 'r01-s1', 'r1-s01', 'r51-s1', 'r1-s51', 'r50-s50\n'])
      expect(venueSeatIdSchema.safeParse(seatId).success).toBe(false);
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
