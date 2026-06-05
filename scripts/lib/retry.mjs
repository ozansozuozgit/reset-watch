// Retry an idempotent async operation a few times before giving up. Used for
// status-page fetches: status.claude.com (Atlassian Statuspage behind CloudFront)
// intermittently 405s the shared GitHub Actions runner IP, so a single failed GET
// would silently drop Anthropic incidents from the snapshot. Retries are safe here
// because these are read-only GETs.

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function withRetry(fn, { attempts = 3, delayMs = 800 } = {}) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      // Linear backoff between attempts; no wait after the final failure.
      if (attempt < attempts) await sleep(delayMs * attempt)
    }
  }
  throw lastError
}

// Try a primary source, fall back to a secondary when the primary throws or
// returns nothing. Used so the budgeted Tavily search degrades to the free
// scrapers when its key is missing or the monthly credit cap is reached, instead
// of zeroing the topic. The optional onPrimaryIssue callback reports WHY the
// fallback happened (a 403, "budget reached", or "0 items") for CI-log diagnosis;
// a throw from the fallback propagates to the caller.
export async function runWithFallback(primary, fallback, onPrimaryIssue) {
  let result
  try {
    result = await primary()
  } catch (error) {
    onPrimaryIssue?.(error instanceof Error ? error.message : String(error))
    return fallback()
  }
  if (Array.isArray(result) && result.length > 0) return result
  onPrimaryIssue?.('returned 0 items')
  return fallback()
}
