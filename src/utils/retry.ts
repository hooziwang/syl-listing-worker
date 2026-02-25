export interface RetryOptions {
  attempts: number;
  baseMs: number;
  maxMs: number;
  jitter: number;
  onRetry?: (attempt: number, error: Error, waitMs: number) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeDelayMs(attempt: number, baseMs: number, maxMs: number, jitter: number): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  const range = exp * jitter;
  const rand = (Math.random() * 2 - 1) * range;
  return Math.max(0, Math.floor(exp + rand));
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= opts.attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      lastError = err;
      if (attempt >= opts.attempts) {
        break;
      }
      const waitMs = computeDelayMs(attempt, opts.baseMs, opts.maxMs, opts.jitter);
      opts.onRetry?.(attempt, err, waitMs);
      await sleep(waitMs);
    }
  }

  throw lastError ?? new Error("retry failed");
}
