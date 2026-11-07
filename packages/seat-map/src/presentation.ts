import type { MapSeat, VenueMapViewProps } from './types.js';

const colors = [0x2563eb, 0x7c3aed, 0x059669, 0xd97706, 0xdb2777, 0x0891b2];
export const stateLabels: Record<MapSeat['state'], string> = {
  AVAILABLE: 'Доступно',
  HELD: 'Временно забронировано',
  SOLD: 'Продано',
  DISABLED: 'Недоступно',
};
export function categoryColor(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return colors[hash % colors.length]!;
}
export function canSelect(seat: MapSeat, props: VenueMapViewProps): boolean {
  return (
    !props.disabled &&
    (!!props.edit || (seat.state === 'AVAILABLE' && !props.disabledIds?.includes(seat.seatId)))
  );
}
export function describeSeat(seat: MapSeat, currency = 'EUR'): string {
  const price = new Intl.NumberFormat('ru', { style: 'currency', currency }).format(
    seat.priceMinor / 100,
  );
  return `Ряд ${seat.row}, место ${seat.number} · ${seat.categoryName} · ${price} · ${stateLabels[seat.state]}`;
}
