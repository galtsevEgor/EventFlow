import assert from 'node:assert/strict';
import test from 'node:test';
import { formatDate, formatPrice } from '../app/format.ts';

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
      assert.equal(formatDate(instant, timeZone), expected.format(new Date(instant)));
  }
});

test('EUR amounts retain cent precision and the existing Russian currency format', () => {
  const expected = new Intl.NumberFormat('ru', { style: 'currency', currency: 'EUR' });
  for (const minor of [0, 1, 99, 100, 2500, 10000000])
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
    assert.equal(format.formatDate(instant, 'Europe/Chisinau'), expected.format(new Date(instant)));
    format.formatDate(instant, 'UTC');
  }
  assert.notEqual(format.formatPrice(1), format.formatPrice(2500));
  assert.equal(dates.mock.callCount(), 2);
  assert.equal(prices.mock.callCount(), 1);
});

test('invalid dates and timezone names fail without affecting a valid event', () => {
  const instant = instants[0];
  const expected = formatDate(instant, 'Europe/Chisinau');
  assert.throws(() => formatDate(instant, 'invalid/timezone'), RangeError);
  assert.throws(() => formatDate('invalid-date', 'Europe/Chisinau'), RangeError);
  assert.equal(formatDate(instant, 'Europe/Chisinau'), expected);
});
