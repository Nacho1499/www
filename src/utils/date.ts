/**
 * ISO 8601 date validation utilities.
 *
 * Exported from src/ so they can be imported by both application code and
 * build-time scripts while remaining in the TypeScript compilation boundary
 * and accessible to Vitest.
 */

/**
 * Strict ISO 8601 date regex.
 *
 * Accepts:
 *   • Bare date:          2026-06-15
 *   • UTC datetime:       2026-06-15T14:22:00Z
 *   • Datetime + ms:      2026-06-15T14:22:00.000Z
 *   • Offset datetime:    2026-06-15T14:22:00+05:30
 *
 * Rejects anything new Date() would otherwise accept but is not a valid
 * ISO 8601 string, e.g. "1", "August 14", "2026-1-5" (missing zero-pad).
 */
const ISO_DATE_RE =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/;

/**
 * Returns true only when `v` is a structurally valid ISO 8601 date string
 * AND the year/month/day combination represents a calendar date that actually
 * exists — e.g. `2026-02-31` and `2026-04-31` are rejected because those
 * days do not exist in their respective months.
 *
 * The calendar check works by constructing a local Date with the extracted
 * components and verifying that JavaScript's Date normalisation did not roll
 * the values forward into the next month (which happens for out-of-range days
 * such as Feb 31 → Mar 3).
 */
export function isIsoDate(v: unknown): boolean {
  if (typeof v !== 'string' || v.trim().length === 0) return false;

  const s = v.trim();
  if (!ISO_DATE_RE.test(s)) return false;

  // Extract the date portion (first 10 chars are always YYYY-MM-DD after the
  // regex passes).
  const year = parseInt(s.slice(0, 4), 10);
  const month = parseInt(s.slice(5, 7), 10); // 1-based
  const day = parseInt(s.slice(8, 10), 10);

  // Construct a Date using local components and check for roll-over.
  // month - 1 because Date constructor takes 0-based month.
  const d = new Date(year, month - 1, day);
  return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day;
}
