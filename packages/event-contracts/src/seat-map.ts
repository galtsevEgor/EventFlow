import { z } from 'zod';

export const MAX_VENUE_ROWS = 50;
export const MAX_SEATS_PER_ROW = 50;
export const MAX_VENUE_SEATS = 1_000;

export const MIN_VENUE_MAP_COORDINATE = 0;
export const MAX_VENUE_MAP_COORDINATE = 10_000;
export const MIN_VENUE_MAP_DIMENSION = 200;
export const MAX_VENUE_MAP_DIMENSION = 10_000;
export const MIN_VENUE_FEATURE_DIMENSION = 20;
export const MAX_VENUE_FEATURE_DIMENSION = 10_000;
export const MAX_VENUE_MAP_FEATURES = 40;

export const seatRadius = 14;

export function parseVenueSeatId(seatId: string) {
  const match = /^r([1-9]\d*)-s([1-9]\d*)$/.exec(seatId);
  if (!match) return undefined;
  const row = Number(match[1]);
  const number = Number(match[2]);
  if (row <= MAX_VENUE_ROWS && number <= MAX_SEATS_PER_ROW) return { row, number };
  return undefined;
}

export const venueSeatIdSchema = z
  .string()
  .refine((seatId) => parseVenueSeatId(seatId) !== undefined, 'Неверный идентификатор места.');

const coordinate = z.number().finite().min(MIN_VENUE_MAP_COORDINATE).max(MAX_VENUE_MAP_COORDINATE);
const mapDimension = z.number().finite().min(MIN_VENUE_MAP_DIMENSION).max(MAX_VENUE_MAP_DIMENSION);
const featureDimension = z
  .number()
  .finite()
  .min(MIN_VENUE_FEATURE_DIMENSION)
  .max(MAX_VENUE_FEATURE_DIMENSION);
export const venueMapSchema = z
  .strictObject({
    version: z.literal(1),
    width: mapDimension,
    height: mapDimension,
    seats: z
      .array(
        z.strictObject({
          seatId: venueSeatIdSchema,
          x: coordinate,
          y: coordinate,
          rotation: z.number().finite().min(-180).max(180),
        }),
      )
      .min(1)
      .max(MAX_VENUE_SEATS),
    features: z
      .array(
        z.strictObject({
          id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
          kind: z.enum(['stage', 'sector', 'aisle']),
          label: z.string().trim().min(1).max(60),
          x: coordinate,
          y: coordinate,
          width: featureDimension,
          height: featureDimension,
        }),
      )
      .max(MAX_VENUE_MAP_FEATURES),
  })
  .superRefine((map, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: 'custom', path, message });
    const ids = new Set<string>();
    map.seats.forEach((seat, i) => {
      if (ids.has(seat.seatId)) issue(['seats', i, 'seatId'], 'Место указано повторно.');
      ids.add(seat.seatId);
      if (
        seat.x < seatRadius ||
        seat.y < seatRadius ||
        seat.x > map.width - seatRadius ||
        seat.y > map.height - seatRadius
      )
        issue(['seats', i], 'Место выходит за границы зала.');
      for (let j = 0; j < i; j++) {
        const other = map.seats[j]!;
        if (Math.hypot(seat.x - other.x, seat.y - other.y) < seatRadius * 2 - 0.01) {
          issue(['seats', i], 'Места пересекаются.');
          break;
        }
      }
    });
    const features = new Set<string>();
    map.features.forEach((feature, i) => {
      if (features.has(feature.id)) issue(['features', i, 'id'], 'Объект указан повторно.');
      features.add(feature.id);
      if (feature.x + feature.width > map.width || feature.y + feature.height > map.height)
        issue(['features', i], 'Объект выходит за границы зала.');
      if (
        feature.kind !== 'sector' &&
        map.seats.some(
          (seat) =>
            seat.x + seatRadius > feature.x &&
            seat.x - seatRadius < feature.x + feature.width &&
            seat.y + seatRadius > feature.y &&
            seat.y - seatRadius < feature.y + feature.height,
        )
      )
        issue(['features', i], 'Сцена или проход пересекает место.');
    });
  });
export type VenueMap = z.infer<typeof venueMapSchema>;
