function isProbablyRetryable(err) {
  const msg = String(err?.message ?? err ?? "");
  const code = err?.code;
  return (
    code === 429 ||
    /429|timeout|TIMEOUT|ECONNRESET|ECONNREFUSED|503|502|504|fetch failed|too many requests|rate limit/i.test(
      msg,
    )
  );
}

/**
 * Retry RPC calls with exponential backoff (Phase 1.3).
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ maxAttempts?: number; baseMs?: number; maxMs?: number }} [opts]
 * @returns {Promise<T>}
 */
export async function withRpcRetry(fn, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 5;
  const baseMs = opts.baseMs ?? 500;
  const maxMs = opts.maxMs ?? 12_000;
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const retryable = attempt < maxAttempts - 1 && isProbablyRetryable(e);
      if (!retryable) throw e;
      const is429 = String(e?.message ?? "").includes("429") || e?.code === 429;
      const mult = is429 ? 3 : 1;
      const delay = Math.min(baseMs * mult * 2 ** attempt, maxMs);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
