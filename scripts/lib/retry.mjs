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
// returns nothing. Used so a free real API (Reddit/Bluesky) that 403s or comes
// up empty from a CI runner IP degrades to the DuckDuckGo snippet scrape instead
// of zeroing the topic. A throw from the fallback propagates to the caller so it
// can be recorded in snapshot.errors.
export async function runWithFallback(primary, fallback) {
  let result
  try {
    result = await primary()
  } catch {
    result = null
  }
  if (Array.isArray(result) && result.length > 0) return result
  return fallback()
}
