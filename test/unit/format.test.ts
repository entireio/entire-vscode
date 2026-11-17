import { describe, expect, it } from 'vitest';
import { formatPosition, formatTokens, headline, joinParts, relativeTime } from '../../src/core/format';
import { isWellFormed } from './support';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Local noon, so that date-only output is the same in every time zone. */
const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime();

describe('relativeTime', () => {
  it.each([undefined, '', 'not a date', Number.NaN, Number.POSITIVE_INFINITY])('is empty for the unknown time %j', (time) => {
    expect(relativeTime(time, NOW)).toBe('');
  });

  it.each([
    [0, 'just now'],
    [59 * SECOND, 'just now'],
    [MINUTE, '1m ago'],
    [5 * MINUTE + 30 * SECOND, '5m ago'],
    [59 * MINUTE + 59 * SECOND, '59m ago'],
    [HOUR, '1h ago'],
    [3 * HOUR + 59 * MINUTE, '3h ago'],
    [23 * HOUR + 59 * MINUTE, '23h ago'],
    [DAY, '1d ago'],
    [6 * DAY + 23 * HOUR, '6d ago'],
    [29 * DAY + 23 * HOUR, '29d ago'],
  ])('describes a time %i ms ago as "%s"', (elapsed, expected) => {
    expect(relativeTime(NOW - elapsed, NOW)).toBe(expected);
  });

  it('says "just now" for a time slightly in the future, as clock skew produces', () => {
    expect(relativeTime(NOW + 5 * SECOND, NOW)).toBe('just now');
  });

  it('switches to a date after 30 days, without the year in the same year', () => {
    expect(relativeTime(new Date(2026, 3, 1, 12).getTime(), NOW)).toBe('Apr 1');
    expect(relativeTime(NOW - 30 * DAY, NOW)).toBe('May 16');
  });

  it('adds the year for a date in another year', () => {
    expect(relativeTime(new Date(2024, 11, 25, 12).getTime(), NOW)).toBe('Dec 25, 2024');
  });

  it('accepts an ISO string', () => {
    expect(relativeTime('2026-01-02T03:04:05Z', Date.parse('2026-01-02T03:09:05Z'))).toBe('5m ago');
    expect(relativeTime('2026-01-02T03:04:05+02:00', Date.parse('2026-01-02T03:04:05Z'))).toBe('2h ago');
  });

  it('measures from the current time by default', () => {
    expect(relativeTime(Date.now() - 2 * HOUR - MINUTE)).toBe('2h ago');
  });
});

describe('formatPosition', () => {
  it('reads as a place in a sequence', () => {
    expect(formatPosition({ ordinal: 12, total: 249, mayHaveEarlier: false })).toBe('12 of 249');
    expect(formatPosition({ ordinal: 1, total: 1, mayHaveEarlier: false })).toBe('1 of 1');
  });

  it('marks a total that may be too low with a plus sign', () => {
    expect(formatPosition({ ordinal: 12, total: 249, mayHaveEarlier: true })).toBe('12 of 249+');
  });

  it('groups thousands', () => {
    expect(formatPosition({ ordinal: 1200, total: 2490, mayHaveEarlier: true })).toBe('1,200 of 2,490+');
  });
});

describe('formatTokens', () => {
  it.each([
    [0, '0'],
    [7, '7'],
    [950, '950'],
    [999, '999'],
    [1000, '1K'],
    [1500, '1.5K'],
    [12_400, '12.4K'],
    [12_449, '12.4K'],
    [100_000, '100K'],
    [999_900, '999.9K'],
    [1_000_000, '1M'],
    [1_250_000, '1.3M'],
    [10_407_798, '10.4M'],
    [999_900_000, '999.9M'],
    [1_000_000_000, '1B'],
    [2_500_000_000, '2.5B'],
  ])('formats %i as %s', (count, expected) => {
    expect(formatTokens(count)).toBe(expected);
  });

  // 999,950 rounds to 1000.0 thousands, which should roll over to the next unit.
  it.each([
    [999_950, '1M'],
    [999_999, '1M'],
    [999_950_000, '1B'],
    [999_999_999, '1B'],
  ])('rolls %i over to the next unit as %s instead of printing four digits', (count, expected) => {
    expect(formatTokens(count)).toBe(expected);
  });
});

describe('headline', () => {
  it.each([undefined, '', '   ', '\n\n  \n'])('is empty for %j', (text) => {
    expect(headline(text)).toBe('');
  });

  it('returns a short single line unchanged', () => {
    expect(headline('Fix the parser')).toBe('Fix the parser');
  });

  it('returns the first non-empty line, trimmed', () => {
    expect(headline('\n\n   Fix the parser  \nand also the lexer\n')).toBe('Fix the parser');
  });

  it('shortens to 90 characters by default, ending with an ellipsis', () => {
    const result = headline('x'.repeat(200));
    expect(result).toHaveLength(90);
    expect(result).toBe(`${'x'.repeat(89)}…`);
  });

  it('leaves a line of exactly the limit alone', () => {
    expect(headline('x'.repeat(90))).toBe('x'.repeat(90));
    expect(headline('abcde', 5)).toBe('abcde');
  });

  it('honors a custom limit', () => {
    expect(headline('abcdefghij', 5)).toBe('abcd…');
    expect(headline('abcdefghij', 5)).toHaveLength(5);
  });

  it('measures the limit after trimming', () => {
    expect(headline(`   ${'x'.repeat(90)}   `)).toBe('x'.repeat(90));
  });

  // Cutting between the two halves of a surrogate pair leaves a lone
  // surrogate, which renders as a replacement character.
  it('does not cut an emoji in half', () => {
    const result = headline(`${'x'.repeat(88)}😀 and more text`, 90);
    expect(isWellFormed(result)).toBe(true);
  });
});

describe('joinParts', () => {
  it('joins the parts with a middle dot', () => {
    expect(joinParts('Claude Code', '5m ago', 'abc1234')).toBe('Claude Code · 5m ago · abc1234');
  });

  it('skips empty and undefined parts', () => {
    expect(joinParts(undefined, 'Claude Code', '', undefined, 'abc1234')).toBe('Claude Code · abc1234');
  });

  it('returns a single part without a separator', () => {
    expect(joinParts(undefined, 'only')).toBe('only');
  });

  it('is empty when nothing has content', () => {
    expect(joinParts()).toBe('');
    expect(joinParts(undefined, '')).toBe('');
  });
});
