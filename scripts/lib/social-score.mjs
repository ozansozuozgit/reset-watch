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

// Tutorial / how-to framing. These posts mention pain words but are help threads,
// not live outage reports ("here's the fix for slow Codex"), so they get a
// fractional weight rather than counting as full community pain.
export const tutorialTerms = ['how to', 'tip', 'tips', 'try this', 'trick', 'tutorial', 'guide', 'workaround', 'pro tip', 'psa', 'the fix']

// How much an official-source post that mentions a reset term may lift a topic's
// signal. Bounded (and capped at 100 downstream) so one tweet elevates without
// saturating every metric — the honest version of issue #1's flat "+100".
export const OFFICIAL_RESET_BOOST = 18
export const OFFICIAL_HEAT_BOOST = 10

// Heat/pain are normalized toward a saturation point rather than summed with raw
// coefficients, so a search source that returns a roughly fixed number of results
// can't pin the score at 100 from a handful of posts. ~16 recent painful posts
// (decay-weighted ≈ HEAT_SATURATION) reads as fully hot; lighter chatter keeps a
// real 0–100 range.
export const HEAT_SATURATION = 8
export const PAIN_SATURATION = 12

// Recency decay window: a post counts at full weight while fresh, then fades to a
// small floor by the end of the week so stale chatter can't prop up live heat.
const FRESH_HOURS = 6
const STALE_HOURS = 24 * 7
const STALE_FLOOR = 0.05
const NO_TIMESTAMP_WEIGHT = 0.5 // DDG snippets have no date — treat as middling.
const TUTORIAL_WEIGHT = 0.3

const regexCache = new Map()
function wordRegex(term) {
  let re = regexCache.get(term)
  if (!re) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    re = new RegExp(`\\b${escaped}\\b`, 'i')
    regexCache.set(term, re)
  }
  return re
}

// Whole-word / phrase matching so "limit" doesn't fire on "unlimited" and "down"
// doesn't fire on "download".
export function termMatches(text, terms) {
  return terms.filter((term) => wordRegex(term).test(text))
}

// Age-based weight for a single item. Missing/invalid timestamps (DDG snippets)
// fall back to a neutral middling weight.
export function decayWeight(publishedAt, now = new Date()) {
  if (!publishedAt) return NO_TIMESTAMP_WEIGHT
  const ts = new Date(publishedAt).getTime()
  if (Number.isNaN(ts)) return NO_TIMESTAMP_WEIGHT
  const ageHours = (now.getTime() - ts) / 3_600_000
  if (ageHours <= FRESH_HOURS) return 1
  if (ageHours >= STALE_HOURS) return STALE_FLOOR
  const t = (ageHours - FRESH_HOURS) / (STALE_HOURS - FRESH_HOURS)
  return Math.max(STALE_FLOOR, Math.round((1 - t * (1 - STALE_FLOOR)) * 100) / 100)
}

// Combined per-item weight: recency × tutorial penalty.
function itemWeight(item, now) {
  const text = `${item.title} ${(item.matched_terms ?? []).join(' ')}`
  const tutorial = termMatches(text, tutorialTerms).length > 0
  return decayWeight(item.published_at, now) * (tutorial ? TUTORIAL_WEIGHT : 1)
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

export function summarizeTopic(topic, rawItems, overrides, now = new Date()) {
  // Relevance gate: when a topic lists brand terms, keep only items whose title
  // mentions one. This drops cross-topic bleed (a Codex post under Claude Code)
  // and search junk that merely contains a pain word ("eBay selling limits",
  // "iPhone time limit"). Opt-in, so callers without `relevance` are unaffected.
  const relevance = Array.isArray(topic.relevance) ? topic.relevance : []
  const items = dedupe(rawItems)
    .filter((item) => item.score > 0 || item.matched_terms.length)
    .filter((item) => relevance.length === 0 || termMatches(item.title || '', relevance).length > 0)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 40)

  // `volume` stays a plain item count for display ("N public matches"); the heat
  // math runs on recency/tutorial-weighted sums so fresh complaints dominate.
  const volume = items.length
  const weighted = items.map((item) => ({ item, w: itemWeight(item, now) }))
  const termCount = (item, terms) => termMatches(`${item.title} ${(item.matched_terms ?? []).join(' ')}`, terms).length
  const weightedVolume = weighted.reduce((sum, { w }) => sum + w, 0)
  const painHits = weighted.reduce((sum, { item, w }) => sum + w * termCount(item, painTerms), 0)
  const resetHits = weighted.reduce((sum, { item, w }) => sum + w * termCount(item, resetTerms), 0)
  const sourceCounts = items.reduce((acc, item) => ({ ...acc, [item.source]: (acc[item.source] ?? 0) + 1 }), {})
  const topTerms = [...new Set(items.flatMap((item) => item.matched_terms ?? []))].slice(0, 10)
  // Normalized toward saturation (see HEAT_SATURATION) so the score spans 0–100
  // with real range instead of pinning at 100 from a few results. weightedVolume
  // already counts only pain/reset-bearing items (the score>0 filter above).
  let heat = Math.min(100, Math.round((weightedVolume / HEAT_SATURATION) * 100))
  const painChatter = Math.min(100, Math.round((painHits / PAIN_SATURATION) * 100))
  let resetChatter = Math.min(100, Math.round(resetHits * 11 + weightedVolume * 2))
  const sentiment = volume ? Math.max(-0.95, Math.min(0.25, Math.round((resetHits * 0.03 - painHits * 0.08) * 100) / 100)) : 0

  const notes = [
    'Free-only community signal: HN Algolia, Reddit + Bluesky public APIs, with DuckDuckGo snippets as fallback.',
    'Counts are recency-weighted and rate-limit tolerant; use heat as a directional vibe check, not analytics-grade sentiment.',
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
