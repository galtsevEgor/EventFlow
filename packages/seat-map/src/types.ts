import type { VenueMap } from '@eventflow/event-contracts';

export type Point = { x: number; y: number };
export type Rect = Point & { width: number; height: number };
export type Viewport = Point & { scale: number };
export type MapSeat = {
  seatId: string;
  row: number;
  number: number;
  categoryId: string;
  categoryName: string;
  priceMinor: number;
  state: 'AVAILABLE' | 'HELD' | 'SOLD' | 'DISABLED';
};
export type VenueMapViewProps = {
  map: VenueMap;
  seats: MapSeat[];
  selectedIds: string[];
  onSelect: (id: string, additive: boolean) => void;
  disabled?: boolean;
  disabledIds?: string[];
  edit?: boolean;
  onMove?: (ids: string[], dx: number, dy: number) => void;
  onBoxSelect?: (ids: string[], additive: boolean) => void;
  tool?: 'pan' | 'select';
  currency?: string;
};
