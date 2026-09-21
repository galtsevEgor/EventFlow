const priceFormatter = new Intl.NumberFormat('ru', { style: 'currency', currency: 'EUR' });
const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const maximumCachedTimeZones = 32;

export function formatDate(instant: string, timeZone: string) {
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('ru', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone,
    });
    // Bound memory even when events use many different timezone names or aliases.
    if (dateFormatters.size === maximumCachedTimeZones) dateFormatters.clear();
    dateFormatters.set(timeZone, formatter);
  }
  return formatter.format(new Date(instant));
}

export function formatPrice(minor: number) {
  return priceFormatter.format(minor / 100);
}
