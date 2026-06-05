// Tavily search integration. One basic search per topic (1 credit) replaces the
// brittle, IP-blocked free scrapers: Tavily aggregates the social web and honors
// include_domains/date filters at no extra credit cost. These helpers are pure so
// the request shape, result parsing, and budget math are unit-testable.

export const TAVILY_SEARCH_URL = 'https://api.tavily.com/search'
export const TAVILY_COST = 1 // a basic search costs 1 credit; advanced would be 2.

// Build the search request. search_depth 'basic' keeps it at 1 credit; domain and
// date filters are free, so we scope to the social web in a single call.
export function tavilySearchRequest(query, opts = {}) {
  const {
    apiKey,
    includeDomains = [],
    maxResults = 20,
    searchDepth = 'basic',
    days = 7,
    topic = 'general',
  } = opts
  return {
    url: TAVILY_SEARCH_URL,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query,
      search_depth: searchDepth,
      include_domains: includeDomains,
      max_results: maxResults,
      days,
      topic,
    }),
  }
}

// Normalize Tavily results into scoreable posts. `text` (title+content) feeds
// scoreText; `published_at` enables recency decay when Tavily supplies a date.
export function normalizeTavilyResults(json) {
  const results = json?.results
  if (!Array.isArray(results)) return []
  const items = []
  for (const r of results) {
    const text = `${r?.title || ''} ${r?.content || ''}`.replace(/\s+/g, ' ').trim()
    if (!text) continue
    items.push({
      title: (r.title || text).slice(0, 240),
      text,
      url: r.url,
      published_at: r.published_date,
    })
  }
  return items
}

// Budget guard: only spend when this month's used + already-spent-this-run + the
// next call's cost stays at or under the cap.
export function withinBudget(used, spent, cost, cap) {
  return used + spent + cost <= cap
}

// Calendar-month key (UTC) for the monthly counter, e.g. '2026-06'.
export function monthKey(date) {
  return date.toISOString().slice(0, 7)
}
