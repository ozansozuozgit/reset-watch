// Pure scoring/summarisation logic for the social-signal monitor.
// Extracted from fetch-social.mjs so it can be unit-tested without network I/O.
// The script keeps the fetchers and the file/database writes; this module only
// transforms already-fetched items into a per-topic summary.

export const painTerms = [
  'degraded', 'degradation', 'slow', 'slower', 'unusable', 'broken', 'worse', 'regression', 'bug', 'bugs',
  'error', 'errors', 'failed', 'failure', 'outage', 'latency', 'stuck', 'down', 'drain', 'drained', 'limits',
  'limit', 'quota', 'rate limit', 'compaction', 'burned', 'burnt', 'wasted', 'nerfed', 'cooked',
]
export const resetTerms = ['reset', 'resets', 'restored', 'restore', 'refund', 'refunded', 'compensate', 'compensation', 'make-good', 'apology', 'weekly', 'hourly']
export const positiveTerms = ['fixed', 'resolved', 'shipped', 'better', 'improved', 'working']

// How much an official-source post that mentions a reset term may lift a topic's
// signal. Bounded (and capped at 100 downstream) so one tweet elevates without
// saturating every metric — the honest version of issue #1's flat "+100".
export const OFFICIAL_RESET_BOOST = 18
export const OFFICIAL_HEAT_BOOST = 10

export function termMatches(text, terms) {
  const lower = text.toLowerCase()
  return terms.filter((term) => lower.includes(term))
}

export function scoreText(text) {
  const pain = termMatches(text, painTerms)
  const reset = termMatches(text, resetTerms)
  const positive = termMatches(text, positiveTerms)
  return {
    pain,
    reset,
    positive,
    score: pain.length * 8 + reset.length * 5 - positive.length * 3,
  }
}

export function dedupe(items) {
  const seen = new Set()
  return items.filter((item) => {
    const key = `${item.source}:${item.url || item.title}`.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function applyOverride(summary, overrides) {
  const override = overrides.topics?.find((item) => item.id === summary.id || item.product === summary.product)
  if (!override) return summary
  const heat = Math.max(summary.heat, Math.min(100, (summary.heat ?? 0) + (override.heat_boost ?? 0)))
  return {
    ...summary,
    heat,
    reset_chatter: Math.min(100, summary.reset_chatter + (override.reset_chatter_boost ?? 0)),
    pain_chatter: Math.min(100, summary.pain_chatter + (override.pain_chatter_boost ?? 0)),
    notes: [...summary.notes, `Manual override: ${override.note || 'operator marked elevated community signal'}`],
  }
}

// An official-source item that itself mentions a reset term — the high-signal case
// issue #1 targets. Returns the first such item, or undefined.
function officialResetItem(items) {
  return items.find(
    (item) => item.official && termMatches(`${item.title} ${(item.matched_terms ?? []).join(' ')}`, resetTerms).length > 0,
  )
}

export function summarizeTopic(topic, rawItems, overrides) {
  const items = dedupe(rawItems)
    .filter((item) => item.score > 0 || item.matched_terms.length)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 40)

  const volume = items.length
  const painHits = items.reduce((sum, item) => sum + termMatches(`${item.title} ${(item.matched_terms ?? []).join(' ')}`, painTerms).length, 0)
  const resetHits = items.reduce((sum, item) => sum + termMatches(`${item.title} ${(item.matched_terms ?? []).join(' ')}`, resetTerms).length, 0)
  const sourceCounts = items.reduce((acc, item) => ({ ...acc, [item.source]: (acc[item.source] ?? 0) + 1 }), {})
  const topTerms = [...new Set(items.flatMap((item) => item.matched_terms ?? []))].slice(0, 10)
  let heat = Math.min(100, Math.round(volume * 5 + painHits * 5 + resetHits * 2))
  const painChatter = Math.min(100, Math.round(painHits * 8 + volume * 3))
  let resetChatter = Math.min(100, Math.round(resetHits * 10 + volume * 1.5))
  const sentiment = volume ? Math.max(-0.95, Math.min(0.25, Math.round((resetHits * 0.03 - painHits * 0.08) * 100) / 100)) : 0

  const notes = [
    'Free-only community signal: HN Algolia plus DuckDuckGo snippets for X, Reddit, and Bluesky when available.',
    'Counts are noisy and rate-limit tolerant; use heat as a directional vibe check, not analytics-grade sentiment.',
  ]

  // Issue #1: give a verified official reset announcement a bounded, capped lift.
  const official = officialResetItem(items)
  if (official) {
    resetChatter = Math.min(100, resetChatter + OFFICIAL_RESET_BOOST)
    heat = Math.min(100, heat + OFFICIAL_HEAT_BOOST)
    notes.push(`Official reset signal detected: ${official.title}`)
  }

  return applyOverride({
    id: topic.id,
    company: topic.company,
    product: topic.product,
    heat,
    sentiment,
    volume,
    pain_chatter: painChatter,
    reset_chatter: resetChatter,
    top_terms: topTerms,
    sources: sourceCounts,
    examples: items.slice(0, 6).map(({ source, title, url, published_at, matched_terms }) => ({ source, title, url, published_at, matched_terms })),
    notes,
  }, overrides)
}
