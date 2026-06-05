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
