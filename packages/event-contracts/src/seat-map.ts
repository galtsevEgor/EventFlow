import { z } from 'zod';

export const seatRadius = 14;
const coordinate = z.number().finite().min(0).max(10000);
export const venueMapSchema = z
  .strictObject({
    version: z.literal(1),
    width: z.number().finite().min(200).max(10000),
    height: z.number().finite().min(200).max(10000),
    seats: z
      .array(
        z.strictObject({
          seatId: z.string().regex(/^r([1-9]|[1-4]\d|50)-s([1-9]|[1-4]\d|50)$/),
          x: coordinate,
          y: coordinate,
          rotation: z.number().finite().min(-180).max(180),
        }),
      )
      .min(1)
      .max(1000),
    features: z
      .array(
        z.strictObject({
          id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
          kind: z.enum(['stage', 'sector', 'aisle']),
          label: z.string().trim().min(1).max(60),
          x: coordinate,
          y: coordinate,
          width: z.number().finite().min(20).max(10000),
          height: z.number().finite().min(20).max(10000),
        }),
      )
      .max(40),
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
