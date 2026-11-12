import { EVENT_CURRENCY } from '@eventflow/event-contracts';
import { DISPLAY_LOCALE, formatMoney } from '@eventflow/ui/format';

const dateFormatters = new Map<string, Intl.DateTimeFormat>();
const maximumCachedTimeZones = 32;

export function formatEventDateTime(instant: string, timeZone: string) {
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(DISPLAY_LOCALE, {
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
  return formatMoney(minor, EVENT_CURRENCY);
}
