/** Bounded concurrency and retry helpers for the link checker. */

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `task` over `items` with at most `limit` calls in flight, keeping the
 * results in input order.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`concurrency limit must be a positive integer, got ${limit}`);
  }
  const results = new Array<R>(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index] as T, index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export interface RetryPolicy {
  /** Extra attempts after the first one. */
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep?: (ms: number) => Promise<void>;
}

export type AttemptOutcome<T> =
  | { done: true; value: T }
  | { done: false; value: T; delayMs?: number };

/**
 * Calls `attempt` until it reports done or the retries run out, waiting
 * baseDelayMs * 2^n between attempts (or the delay the attempt asks for, such
 * as a Retry-After), capped at maxDelayMs. Returns the last value.
 */
export async function retry<T>(
  attempt: (attemptNumber: number) => Promise<AttemptOutcome<T>>,
  policy: RetryPolicy,
): Promise<{ value: T; attempts: number }> {
  const wait = policy.sleep ?? sleep;
  for (let attemptNumber = 1; ; attemptNumber++) {
    const outcome = await attempt(attemptNumber);
    if (outcome.done || attemptNumber > policy.retries) {
      return { value: outcome.value, attempts: attemptNumber };
    }
    const backoff = policy.baseDelayMs * 2 ** (attemptNumber - 1);
    await wait(Math.min(policy.maxDelayMs, outcome.delayMs ?? backoff));
  }
}
