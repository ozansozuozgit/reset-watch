import { describe, expect, it } from 'vitest'
// @ts-expect-error - plain ESM helper module, no type declarations
import { summarizeTopic, OFFICIAL_RESET_BOOST, OFFICIAL_HEAT_BOOST } from './social-score.mjs'

const topic = { id: 'openai-codex', company: 'openai', product: 'Codex' }
const noOverrides = { generated_at: new Date(0).toISOString(), topics: [] }

// Build a raw item the way the fetchers do (score + matched_terms precomputed).
function item(partial: Record<string, unknown>) {
  return { source: 'x-search-snippet', title: '', url: 'https://x.com/x', score: 10, matched_terms: [], ...partial }
}

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
