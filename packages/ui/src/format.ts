export const DISPLAY_LOCALE = 'ru';

const MINOR_UNITS_PER_AMOUNT = 100;
const MAX_CACHED_CURRENCIES = 8;
const moneyFormatters = new Map<string, Intl.NumberFormat>();
const percentFormatter = new Intl.NumberFormat(DISPLAY_LOCALE, {
  style: 'percent',
  maximumFractionDigits: 1,
});

export function formatMoney(minor: number, currency: string) {
  let formatter = moneyFormatters.get(currency);
  if (!formatter) {
    formatter = new Intl.NumberFormat(DISPLAY_LOCALE, { style: 'currency', currency });
    if (moneyFormatters.size === MAX_CACHED_CURRENCIES) moneyFormatters.clear();
    moneyFormatters.set(currency, formatter);
  }
  return formatter.format(minor / MINOR_UNITS_PER_AMOUNT);
}

export function formatPercent(value: number | null) {
  return value === null ? '—' : percentFormatter.format(value);
}

export function formatLocalDateTime(instant: string) {
  return new Date(instant).toLocaleString(DISPLAY_LOCALE);
}

export function formatLocalTime(instant: string) {
  return new Date(instant).toLocaleTimeString(DISPLAY_LOCALE);
}

export function formatUtcDateTime(instant: string) {
  return new Date(instant).toLocaleString(DISPLAY_LOCALE, { timeZone: 'UTC' });
}
