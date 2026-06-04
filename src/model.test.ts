import { describe, expect, it } from 'vitest'
import { buildPredictions, detectConfirmedReset, relievedPain, COMMUNITY_RESET_THRESHOLD } from './model'
import type { Event } from './data'

const NOW = '2026-06-03T20:00:00Z'

function event(partial: Partial<Event>): Event {
  return {
    id: 'e',
    company: 'openai',
    companyLabel: 'OpenAI',
    product: 'Codex',
    kind: 'metering-bug',
    title: 'Codex usage limits',
    timestamp: '2026-06-03T11:00:00Z',
    severity: 4,
    userImpact: '',
    rootCauseKnown: true,
    usageRelated: true,
    resetIssued: false,
    evidence: 'official',
    sourceLabel: '',
    notes: '',
    ...partial,
  }
}

describe('detectConfirmedReset', () => {
  it('returns null with no reset and no community signal', () => {
    expect(detectConfirmedReset([event({})], undefined, NOW)).toBeNull()
  })

  it('confirms from a fresh curated reset within the window, carrying its confidence', () => {
    const confirmed = detectConfirmedReset(
      [event({ resetIssued: true, resetAt: '2026-06-03T19:45:00Z', resetScope: 'all paid plans', resetConfidence: 'community' })],
      undefined,
      NOW,
    )
    expect(confirmed?.confidence).toBe('community')
    expect(confirmed?.at).toBe('2026-06-03T19:45:00Z')
    expect(confirmed?.scope).toBe('all paid plans')
  })

  it('ignores a stale reset older than the freshness window', () => {
    expect(
      detectConfirmedReset([event({ resetIssued: true, resetAt: '2026-05-31T15:00:00Z' })], undefined, NOW),
    ).toBeNull()
  })

  it('confirms from a cluster of community reset reports', () => {
    const confirmed = detectConfirmedReset([event({})], { communityResetReports: COMMUNITY_RESET_THRESHOLD }, NOW)
    expect(confirmed?.confidence).toBe('community')
    expect(confirmed?.source).toMatch(/crowdsourced/i)
  })

  it('does not confirm below the community threshold', () => {
    expect(
      detectConfirmedReset([event({})], { communityResetReports: COMMUNITY_RESET_THRESHOLD - 1 }, NOW),
    ).toBeNull()
  })

  it('prefers the most authoritative signal when several are present', () => {
    const confirmed = detectConfirmedReset(
      [event({ resetIssued: true, resetAt: '2026-06-03T19:00:00Z', resetConfidence: 'official' })],
      { communityResetReports: 5 },
      NOW,
    )
    expect(confirmed?.confidence).toBe('official')
  })
})

describe('buildPredictions reset confirmation', () => {
  it('flips a company to confirmed on a fresh curated reset', () => {
    const events = [event({ resetIssued: true, resetAt: '2026-06-03T19:45:00Z', resetConfidence: 'community' })]
    const openai = buildPredictions(events, null, undefined, NOW).find((p) => p.company === 'openai')!
    expect(openai.resetConfirmed).toBe(true)
    expect(openai.resetConfirmedConfidence).toBe('community')
  })

  it('flips on community reset reports alone', () => {
    const openai = buildPredictions([event({})], null, { openai: { communityResetReports: 4 } }, NOW).find(
      (p) => p.company === 'openai',
    )!
    expect(openai.resetConfirmed).toBe(true)
  })

  it('leaves a company unconfirmed when nothing fresh is present', () => {
    const anthropic = buildPredictions([event({})], null, undefined, NOW).find((p) => p.company === 'anthropic')!
    expect(anthropic.resetConfirmed).toBe(false)
  })

  it('discounts pain while a reset is freshly confirmed', () => {
    const events = [event({ resetIssued: true, resetAt: '2026-06-03T19:45:00Z', resetConfidence: 'official' })]
    const confirmed = buildPredictions(events, null, undefined, NOW).find((p) => p.company === 'openai')!
    const noReset = buildPredictions([event({})], null, undefined, NOW).find((p) => p.company === 'openai')!
    expect(confirmed.resetConfirmed).toBe(true)
    expect(confirmed.painScore).toBeLessThan(noReset.painScore)
  })
})

describe('relievedPain', () => {
  const reset = (confidence: 'official' | 'community') => ({ at: NOW, source: 's', confidence })

  it('returns pain unchanged with no fresh reset', () => {
    expect(relievedPain(80, null)).toBe(80)
  })

  it('discounts more for stronger evidence', () => {
    expect(relievedPain(80, reset('official'))).toBeLessThan(relievedPain(80, reset('community')))
  })

  it('never drops below zero', () => {
    expect(relievedPain(5, reset('official'))).toBe(0)
  })
})
