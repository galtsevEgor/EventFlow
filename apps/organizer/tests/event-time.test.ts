import { describe, expect, it } from 'vitest';
import { localTimeChoices, localTimeToUtc, parsePrice, utcToLocal } from '../src/event-time';

describe('event schedule conversion', () => {
  it('requires an explicit offset during the autumn DST overlap', () => {
    expect(
      localTimeChoices('2030-10-27T03:30', 'Europe/Chisinau').map((item) => item.offset),
    ).toEqual(['+03:00', '+02:00']);
    expect(() => localTimeToUtc('2030-10-27T03:30', 'Europe/Chisinau', '')).toThrow('дважды');
    expect(localTimeToUtc('2030-10-27T03:30', 'Europe/Chisinau', '+02:00')).toBe(
      '2030-10-27T01:30:00.000Z',
    );
  });
  it('rejects a nonexistent spring time instead of silently moving it forward', () => {
    expect(localTimeChoices('2030-03-31T03:30', 'Europe/Chisinau')).toEqual([]);
    expect(() => localTimeToUtc('2030-03-31T03:30', 'Europe/Chisinau', '')).toThrow('нет');
  });
  it('round-trips an explicit instant independently of the browser system timezone', () => {
    const local = utcToLocal('2030-06-01T16:00:00Z', 'Europe/Chisinau');
    expect(local.value).toBe('2030-06-01T19:00');
    expect(localTimeToUtc(local.value, 'Europe/Chisinau', local.offset)).toBe(
      '2030-06-01T16:00:00.000Z',
    );
    expect(() => localTimeToUtc(local.value, 'Invalid/Zone', '')).toThrow();
  });
  it('converts decimal money to integer cents without accepting fractions of cents', () => {
    expect(parsePrice('19,90')).toBe(1990);
    expect(parsePrice('0.29')).toBe(29);
    for (const value of ['0', '-1', '1.001', 'NaN', '1e4', '1 000', '1000001'])
      expect(() => parsePrice(value)).toThrow();
  });
});
