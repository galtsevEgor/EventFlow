import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatLocalDateTime,
  formatLocalTime,
  formatMoney,
  formatPercent,
  formatUtcDateTime,
} from '@eventflow/ui/format';
import { formatEventDateTime, formatPrice } from '../app/format.ts';

const dateOptions = { dateStyle: 'long', timeStyle: 'short' };
const instants = ['2028-03-26T00:30:00Z', '2028-03-26T01:30:00Z', '2028-06-01T23:45:00Z'];

test('event dates retain their timezone through offset changes and formatter turnover', () => {
  const timeZones = ['Europe/Chisinau', 'UTC', 'Pacific/Kiritimati', 'America/New_York'];
  for (const timeZone of [
    ...timeZones,
    ...Intl.supportedValuesOf('timeZone').slice(0, 40),
    ...timeZones,
  ]) {
    const expected = new Intl.DateTimeFormat('ru', { ...dateOptions, timeZone });
    for (const instant of instants)
      assert.equal(formatEventDateTime(instant, timeZone), expected.format(new Date(instant)));
  }
});

test('EUR amounts retain cent precision and the existing Russian currency format', () => {
  const expected = new Intl.NumberFormat('ru', { style: 'currency', currency: 'EUR' });
  for (const minor of [-2500, 0, 1, 99, 100, 2500, 10000000])
    assert.equal(formatPrice(minor), expected.format(minor / 100));
});

test('repeated renders reuse formatters while formatting each new value', async (t) => {
  const NativeDate = Intl.DateTimeFormat;
  const NativePrice = Intl.NumberFormat;
  const dates = t.mock.method(Intl, 'DateTimeFormat', function (locale, options) {
    return new NativeDate(locale, options);
  });
  const prices = t.mock.method(Intl, 'NumberFormat', function (locale, options) {
    return new NativePrice(locale, options);
  });
  const format = await import('../app/format.ts?reuse');
  const expected = new NativeDate('ru', { ...dateOptions, timeZone: 'Europe/Chisinau' });
  for (const instant of instants) {
    assert.equal(
      format.formatEventDateTime(instant, 'Europe/Chisinau'),
      expected.format(new Date(instant)),
    );
    format.formatEventDateTime(instant, 'UTC');
  }
  const dollars = new NativePrice('ru', { style: 'currency', currency: 'USD' });
  for (const minor of [1, 2500])
    assert.equal(formatMoney(minor, 'USD'), dollars.format(minor / 100));
  assert.equal(dates.mock.callCount(), 2);
  assert.equal(prices.mock.callCount(), 1);
});

test('device time and UTC report time follow different clocks', (t) => {
  const previous = process.env.TZ;
  process.env.TZ = 'Pacific/Kiritimati';
  t.after(() => {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  });
  const instant = '2028-06-01T23:45:00Z';
  const date = new Date(instant);
  assert.equal(
    formatLocalDateTime(instant),
    date.toLocaleString('ru', { timeZone: 'Pacific/Kiritimati' }),
  );
  assert.equal(
    formatLocalTime(instant),
    date.toLocaleTimeString('ru', { timeZone: 'Pacific/Kiritimati' }),
  );
  assert.equal(formatUtcDateTime(instant), date.toLocaleString('ru', { timeZone: 'UTC' }));
  assert.notEqual(formatLocalDateTime(instant), formatUtcDateTime(instant));
  assert.equal(formatPercent(null), '—');
  assert.equal(
    formatPercent(0.123),
    new Intl.NumberFormat('ru', {
      style: 'percent',
      maximumFractionDigits: 1,
    }).format(0.123),
  );
});

test('invalid dates and timezone names fail without affecting a valid event', () => {
  const instant = instants[0];
  const expected = formatEventDateTime(instant, 'Europe/Chisinau');
  assert.throws(() => formatEventDateTime(instant, 'invalid/timezone'), RangeError);
  assert.throws(() => formatEventDateTime('invalid-date', 'Europe/Chisinau'), RangeError);
  assert.equal(formatEventDateTime(instant, 'Europe/Chisinau'), expected);
});
