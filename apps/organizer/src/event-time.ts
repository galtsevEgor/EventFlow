import { Temporal } from '@js-temporal/polyfill';

export function localTimeChoices(value: string, zone: string) {
  const local = Temporal.PlainDateTime.from(value);
  const earlier = local.toZonedDateTime(zone, { disambiguation: 'earlier' });
  const later = local.toZonedDateTime(zone, { disambiguation: 'later' });
  const matches = [earlier, later].filter((date) => date.toPlainDateTime().equals(local));
  return [
    ...new Map(
      matches.map((date) => [
        date.epochNanoseconds.toString(),
        { offset: date.offset, instant: date.toInstant().toString({ fractionalSecondDigits: 3 }) },
      ]),
    ).values(),
  ];
}
export function localTimeToUtc(value: string, zone: string, offset: string) {
  const choices = localTimeChoices(value, zone);
  if (choices.length === 0)
    throw new Error('Такого локального времени нет: часы переведены вперёд.');
  const selected =
    choices.length === 1 ? choices[0] : choices.find((item) => item.offset === offset);
  if (!selected) throw new Error('Это время встречается дважды. Выберите смещение UTC.');
  return selected.instant;
}
export function utcToLocal(value: string, zone: string) {
  const date = Temporal.Instant.from(value).toZonedDateTimeISO(zone);
  return {
    value: date.toPlainDateTime().toString({ smallestUnit: 'minute' }),
    offset: date.offset,
  };
}
export function parsePrice(value: string) {
  const normalized = value.trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized))
    throw new Error('Укажите цену в евро, максимум два знака после запятой.');
  const [whole, fraction = ''] = normalized.split('.');
  const price = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(price) || price <= 0 || price > 100_000_000)
    throw new Error('Проверьте цену: нужна положительная сумма в допустимом диапазоне.');
  return price;
}
