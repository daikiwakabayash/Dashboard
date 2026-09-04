import { describe, it, expect } from 'vitest';
import { parseEventDate, isPastEvent, EVENT_SECTIONS, genId } from '../lib/events.js';

const NOW = new Date(2026, 7, 15); // 2026-08-15

describe('events: parseEventDate', () => {
  it('parses M/D and M月D日', () => {
    expect(parseEventDate('8/20', NOW).date.getMonth()).toBe(7);
    expect(parseEventDate('8月20日', NOW).date.getDate()).toBe(20);
    expect(parseEventDate('8月22日(金)', NOW).date.getDate()).toBe(22);
  });
  it('takes the first date when multiple', () => {
    expect(parseEventDate('9/1,9/8', NOW).date.getMonth()).toBe(8);
  });
  it('recurring / undecided → recurring flag', () => {
    expect(parseEventDate('毎週月曜', NOW).recurring).toBe(true);
    expect(parseEventDate('未定', NOW).recurring).toBe(true);
    expect(parseEventDate('自由', NOW).recurring).toBe(true);
  });
  it('unparseable → null', () => {
    expect(parseEventDate('', NOW)).toBeNull();
    expect(parseEventDate('あとで', NOW)).toBeNull();
  });
  it('a date that appears far in the future rolls to previous year', () => {
    // 12/20 evaluated on 1/5 is ~11 months ahead → treat as last year (past leftover)
    const jan = new Date(2026, 0, 5);
    expect(parseEventDate('12/20', jan).date.getFullYear()).toBe(2025);
    // same-year past date stays in current year
    expect(parseEventDate('3/13', NOW).date.getFullYear()).toBe(2026);
  });
});

describe('events: isPastEvent', () => {
  it('past dates are past, future not, recurring never', () => {
    expect(isPastEvent('8/10', NOW)).toBe(true);
    expect(isPastEvent('8/20', NOW)).toBe(false);
    expect(isPastEvent('8/15', NOW)).toBe(false); // today is not past
    expect(isPastEvent('毎週木曜日', NOW)).toBe(false);
    expect(isPastEvent('未定', NOW)).toBe(false);
    expect(isPastEvent('', NOW)).toBe(false);
  });
});

describe('events: sections + genId', () => {
  it('has 3 sections with columns', () => {
    expect(EVENT_SECTIONS.map(s => s.key)).toEqual(['study', 'event', 'bukatsu']);
    expect(EVENT_SECTIONS.every(s => Array.isArray(s.cols) && s.cols.length > 0)).toBe(true);
  });
  it('genId unique-ish', () => { expect(genId('r')).not.toBe(genId('r')); });
});
