'use client';
import type { Schemas } from '@eventflow/api-client';
import { VenueMapView } from '@eventflow/seat-map';
import { money } from './client';

export function SaleSeats({
  sale,
  selectedIds,
  disabled,
  onSelect,
}: {
  sale: Schemas['PublicSale'];
  selectedIds: string[];
  disabled: boolean;
  onSelect: (id: string) => void;
}) {
  const unavailable =
    selectedIds.length >= 6
      ? sale.seats.filter((s) => !selectedIds.includes(s.seatId)).map((s) => s.seatId)
      : [];
  if (sale.seatMap)
    return (
      <VenueMapView
        map={sale.seatMap}
        seats={sale.seats}
        selectedIds={selectedIds}
        disabled={disabled}
        disabledIds={unavailable}
        onSelect={(id) => onSelect(id)}
        currency={sale.currency}
      />
    );
  const columns = Math.max(...sale.seats.map((seat) => seat.number));
  const rows = [...new Set(sale.seats.map((seat) => seat.row))];
  const positions = new Map(sale.seats.map((seat) => [`${seat.row}:${seat.number}`, seat]));
  return (
    <>
      <p className="seat-legend">
        <span>Свободно</span>
        <span>Выбрано</span>
        <span>Занято</span>
      </p>
      <div
        className="seat-map"
        role="region"
        aria-label="Схема мест, прокрутка по горизонтали"
        tabIndex={0}
      >
        <div className="stage">СЦЕНА</div>
        {rows.map((row) => (
          <div
            className="seat-row"
            key={row}
            style={{ gridTemplateColumns: `44px repeat(${columns}, 42px)` }}
          >
            <span className="row-label">Ряд {row}</span>
            {Array.from({ length: columns }, (_, i) => {
              const seat = positions.get(`${row}:${i + 1}`);
              if (!seat) return <span key={i} aria-hidden="true" />;
              const pressed = selectedIds.includes(seat.seatId);
              return (
                <button
                  key={i}
                  type="button"
                  className="seat"
                  aria-pressed={pressed}
                  aria-label={`Ряд ${row}, место ${seat.number}, ${seat.categoryName}, ${money(seat.priceMinor)}${seat.state !== 'AVAILABLE' ? ', занято' : ''}`}
                  disabled={
                    disabled || seat.state !== 'AVAILABLE' || unavailable.includes(seat.seatId)
                  }
                  onClick={() => onSelect(seat.seatId)}
                >
                  {seat.number}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </>
  );
}
