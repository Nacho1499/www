import { describe, expect, it } from 'vitest';
import { isIsoDate } from '../utils/date';

describe('isIsoDate', () => {
  // -------------------------------------------------------------------------
  // Valid dates
  // -------------------------------------------------------------------------
  describe('accepts valid ISO 8601 strings', () => {
    it('accepts a bare date', () => {
      expect(isIsoDate('2026-06-15')).toBe(true);
    });

    it('accepts a UTC datetime', () => {
      expect(isIsoDate('2026-06-15T14:22:00Z')).toBe(true);
    });

    it('accepts a datetime with milliseconds', () => {
      expect(isIsoDate('2026-06-15T14:22:00.000Z')).toBe(true);
    });

    it('accepts a datetime with positive offset', () => {
      expect(isIsoDate('2026-06-15T14:22:00+05:30')).toBe(true);
    });

    it('accepts a datetime with negative offset', () => {
      expect(isIsoDate('2026-06-15T00:00:00-08:00')).toBe(true);
    });

    it('accepts January 31 (31 days)', () => {
      expect(isIsoDate('2026-01-31')).toBe(true);
    });

    it('accepts March 31 (31 days)', () => {
      expect(isIsoDate('2026-03-31')).toBe(true);
    });

    it('accepts April 30 (30 days)', () => {
      expect(isIsoDate('2026-04-30')).toBe(true);
    });

    it('accepts February 28 in a non-leap year', () => {
      expect(isIsoDate('2026-02-28')).toBe(true);
    });

    it('accepts February 29 in a leap year', () => {
      expect(isIsoDate('2024-02-29')).toBe(true);
    });

    it('accepts the first day of every month', () => {
      for (let m = 1; m <= 12; m++) {
        const s = `2026-${String(m).padStart(2, '0')}-01`;
        expect(isIsoDate(s), s).toBe(true);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Impossible calendar dates (structurally valid regex, but day out of range)
  // -------------------------------------------------------------------------
  describe('rejects impossible calendar dates', () => {
    it('rejects February 29 in a non-leap year (2026-02-29)', () => {
      expect(isIsoDate('2026-02-29')).toBe(false);
    });

    it('rejects February 30', () => {
      expect(isIsoDate('2026-02-30')).toBe(false);
    });

    it('rejects February 31', () => {
      expect(isIsoDate('2026-02-31')).toBe(false);
    });

    it('rejects April 31 (April has 30 days)', () => {
      expect(isIsoDate('2026-04-31')).toBe(false);
    });

    it('rejects June 31', () => {
      expect(isIsoDate('2026-06-31')).toBe(false);
    });

    it('rejects September 31', () => {
      expect(isIsoDate('2026-09-31')).toBe(false);
    });

    it('rejects November 31', () => {
      expect(isIsoDate('2026-11-31')).toBe(false);
    });

    it('rejects February 29 in a century non-leap year (1900-02-29)', () => {
      expect(isIsoDate('1900-02-29')).toBe(false);
    });

    it('accepts February 29 in a 400-year multiple (2000-02-29)', () => {
      expect(isIsoDate('2000-02-29')).toBe(true);
    });

    it('rejects Feb 31 with a time component', () => {
      expect(isIsoDate('2026-02-31T12:00:00Z')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Structural / format rejections
  // -------------------------------------------------------------------------
  describe('rejects structurally invalid strings', () => {
    it('rejects a missing zero-pad on month (2026-1-5)', () => {
      expect(isIsoDate('2026-1-5')).toBe(false);
    });

    it('rejects a free-form date string ("August 14")', () => {
      expect(isIsoDate('August 14')).toBe(false);
    });

    it('rejects a bare number ("1")', () => {
      expect(isIsoDate('1')).toBe(false);
    });

    it('rejects an empty string', () => {
      expect(isIsoDate('')).toBe(false);
    });

    it('rejects whitespace-only string', () => {
      expect(isIsoDate('   ')).toBe(false);
    });

    it('rejects month 00', () => {
      expect(isIsoDate('2026-00-15')).toBe(false);
    });

    it('rejects month 13', () => {
      expect(isIsoDate('2026-13-01')).toBe(false);
    });

    it('rejects day 00', () => {
      expect(isIsoDate('2026-01-00')).toBe(false);
    });

    it('rejects non-string inputs', () => {
      expect(isIsoDate(null)).toBe(false);
      expect(isIsoDate(undefined)).toBe(false);
      expect(isIsoDate(20260615)).toBe(false);
      expect(isIsoDate({})).toBe(false);
    });
  });
});
