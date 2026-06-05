import { describe, expect, it } from 'vitest'
import {
  // @ts-expect-error - plain ESM helper module, no type declarations
  summarizeTopic, termMatches, scoreText, decayWeight, painTerms, OFFICIAL_RESET_BOOST, OFFICIAL_HEAT_BOOST,
} from './social-score.mjs'

const topic = { id: 'openai-codex', company: 'openai', product: 'Codex' }
const noOverrides = { generated_at: new Date(0).toISOString(), topics: [] }
const NOW = new Date('2026-06-05T12:00:00.000Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()

// Build a raw item the way the fetchers do (score + matched_terms precomputed).
function item(partial: Record<string, unknown>) {
  return { source: 'x-search-snippet', title: '', url: 'https://x.com/x', score: 10, matched_terms: [], ...partial }
}

describe('termMatches word boundaries', () => {
  it('does not match a term inside a larger word', () => {
    expect(termMatches('I have unlimited usage left', painTerms)).not.toContain('limit')
    expect(termMatches('the download just finished', painTerms)).not.toContain('down')
  })

  it('matches whole words and multi-word phrases', () => {
    expect(termMatches('hit the rate limit again', painTerms)).toContain('rate limit')
    expect(termMatches('everything is so slow today', painTerms)).toContain('slow')
  })

  it('scoreText ignores substrings hidden in larger words', () => {
    // "unlimited" + "download" should score 0 — no real pain terms present.
    expect(scoreText('unlimited downloads available').score).toBe(0)
  })
})

describe('decayWeight', () => {
  it('is full weight for fresh posts and decays with age', () => {
    expect(decayWeight(hoursAgo(0), NOW)).toBe(1)
    expect(decayWeight(hoursAgo(3), NOW)).toBe(1)
    expect(decayWeight(hoursAgo(24 * 8), NOW)).toBeLessThanOrEqual(0.1)
    expect(decayWeight(hoursAgo(3), NOW)).toBeGreaterThan(decayWeight(hoursAgo(72), NOW))
  })

  it('gives a neutral default when there is no timestamp', () => {
    expect(decayWeight(undefined, NOW)).toBe(0.5)
  })
})

describe('summarizeTopic recency + tutorial weighting', () => {
  it('weights a fresh complaint hotter than an identical stale one', () => {
    const complaint = { title: 'Claude Code is broken and unusable right now', matched_terms: ['broken', 'unusable'] }
    const fresh = summarizeTopic(topic, [item({ ...complaint, published_at: hoursAgo(1) })], noOverrides, NOW)
    const stale = summarizeTopic(topic, [item({ ...complaint, published_at: hoursAgo(24 * 8) })], noOverrides, NOW)
    expect(fresh.heat).toBeGreaterThan(stale.heat)
  })

  it('down-weights tutorial / how-to posts versus genuine complaints', () => {
    const genuine = summarizeTopic(topic, [item({
      title: 'the slow, broken Claude Code is driving me crazy', matched_terms: ['slow', 'broken'], published_at: hoursAgo(1),
    })], noOverrides, NOW)
    const tutorial = summarizeTopic(topic, [item({
      title: 'How to fix the slow, broken Claude Code: try this trick', matched_terms: ['slow', 'broken'], published_at: hoursAgo(1),
    })], noOverrides, NOW)
    expect(tutorial.heat).toBeLessThan(genuine.heat)
  })
})

describe('summarizeTopic official-source boost', () => {
  it('bumps reset_chatter and heat (capped at 100) when an official post mentions a reset term', () => {
    const officialReset = item({
      source: 'official-announcement',
      official: true,
      title: '[OFFICIAL] Codex weekly limits have been reset',
      matched_terms: ['limits', 'reset'],
    })
    const base = summarizeTopic(topic, [{ ...officialReset, official: false }], noOverrides)
    const boosted = summarizeTopic(topic, [officialReset], noOverrides)

    expect(boosted.reset_chatter).toBe(Math.min(100, base.reset_chatter + OFFICIAL_RESET_BOOST))
    expect(boosted.heat).toBe(Math.min(100, base.heat + OFFICIAL_HEAT_BOOST))
    expect(boosted.notes.some((n: string) => /official reset signal/i.test(n))).toBe(true)
  })

  it('never lets the boost push a metric above 100', () => {
    const items = Array.from({ length: 12 }, (_, i) =>
      item({
        source: 'official-announcement',
        official: true,
        url: `https://x.com/post/${i}`,
        title: `[OFFICIAL] limits reset restored refunded weekly ${i}`,
        matched_terms: ['limits', 'reset', 'restored', 'refunded', 'weekly'],
      }),
    )
    const boosted = summarizeTopic(topic, items, noOverrides)
    expect(boosted.reset_chatter).toBe(100)
    expect(boosted.heat).toBeLessThanOrEqual(100)
  })

  it('does not boost when the official post has no reset term (pain only)', () => {
    const officialPain = item({
      source: 'official-announcement',
      official: true,
      title: '[OFFICIAL] Codex is slow today',
      matched_terms: ['slow'],
    })
    const base = summarizeTopic(topic, [{ ...officialPain, official: false }], noOverrides)
    const boosted = summarizeTopic(topic, [officialPain], noOverrides)

    expect(boosted.reset_chatter).toBe(base.reset_chatter)
    expect(boosted.heat).toBe(base.heat)
    expect(boosted.notes.some((n: string) => /official reset signal/i.test(n))).toBe(false)
  })
})
