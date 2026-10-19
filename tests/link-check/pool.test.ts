import { describe, expect, it, vi } from 'vitest';
import { mapLimit, retry } from '../../scripts/link-check/pool';

describe('mapLimit', () => {
  it('never runs more than the limit at once and keeps input order', async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await mapLimit([30, 5, 20, 1, 10, 15], 2, async (delay, index) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, delay));
      inFlight -= 1;
      return index;
    });
    expect(peak).toBe(2);
    expect(results).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('rejects a limit below one', async () => {
    await expect(mapLimit([1], 0, async () => 1)).rejects.toThrow(RangeError);
  });
});

describe('retry', () => {
  it('backs off exponentially, honours a requested delay and caps it', async () => {
    const sleep = vi.fn(async () => undefined);
    let calls = 0;
    const { value, attempts } = await retry(
      async () => {
        calls += 1;
        if (calls === 1) return { done: false, value: 'first' };
        if (calls === 2) return { done: false, value: 'second', delayMs: 60_000 };
        return { done: true, value: 'third' };
      },
      { retries: 3, baseDelayMs: 100, maxDelayMs: 5_000, sleep },
    );
    expect(value).toBe('third');
    expect(attempts).toBe(3);
    expect(sleep.mock.calls).toEqual([[100], [5_000]]);
  });

  it('returns the last value when the retries run out', async () => {
    const sleep = vi.fn(async () => undefined);
    const { value, attempts } = await retry(async (n) => ({ done: false, value: n }), {
      retries: 2,
      baseDelayMs: 10,
      maxDelayMs: 100,
      sleep,
    });
    expect(value).toBe(3);
    expect(attempts).toBe(3);
    expect(sleep.mock.calls).toEqual([[10], [20]]);
  });
});
