interface RetryOptions {
  maxAttempts?: number;
  minDelay?: number;
  maxDelay?: number;
}

function isRetryable(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes("fetch failed") || msg.includes("econnrefused") || msg.includes("timeout")) {
      return true;
    }
  }
  // Check for HTTP status in Response errors
  if (err && typeof err === "object" && "status" in err) {
    const status = (err as { status: number }).status;
    return status === 429 || status >= 500;
  }
  return false;
}

function getRetryAfterMs(err: unknown): number | null {
  if (!err || typeof err !== "object" || !("retryAfterMs" in err)) {
    return null;
  }
  const retryAfterMs = (err as { retryAfterMs?: unknown }).retryAfterMs;
  if (typeof retryAfterMs !== "number" || !Number.isFinite(retryAfterMs)) {
    return null;
  }
  if (retryAfterMs <= 0) return null;
  return Math.floor(retryAfterMs);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const { maxAttempts = 5, minDelay = 1000, maxDelay = 60000 } = opts;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts || !isRetryable(err)) {
        throw err;
      }
      const baseDelay = Math.min(minDelay * 2 ** (attempt - 1), maxDelay);
      const retryAfterMs = getRetryAfterMs(err);
      const delay = retryAfterMs != null
        ? Math.min(maxDelay, Math.max(baseDelay, retryAfterMs))
        : baseDelay;
      console.warn(`Retry ${attempt}/${maxAttempts} after ${delay}ms: ${err}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
}
