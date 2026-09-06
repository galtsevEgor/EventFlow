import { configurationSchema, materializeSeats } from '../events/configuration';

export function publicProjection(eventId: string, input: unknown) {
  const config = configurationSchema.parse(input);
  const seats = materializeSeats(config);
  const date = new Intl.DateTimeFormat('en', {
    timeZone: config.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(config.startsAt));
  const part = (type: string) => date.find((item) => item.type === type)?.value;
  return {
    eventId,
    city: config.city,
    address: config.address,
    timeZone: config.timeZone,
    startsAt: config.startsAt,
    endsAt: config.endsAt,
    localDate: `${part('year')}-${part('month')}-${part('day')}`,
    minPriceMinor: Math.min(...seats.map((seat) => seat.priceMinor)),
    currency: config.currency,
    capacity: seats.length,
  };
}
