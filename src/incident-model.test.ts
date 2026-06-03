import { describe, expect, it } from 'vitest'
import {
  baselineFromBuckets,
  deriveStatus,
  topSymptoms,
  tierIsWorse,
  DEFAULT_THRESHOLDS,
} from './incident-model'
import type { ReportStat } from './reports'

function buckets(counts: number[]): { t: string; c: number }[] {
  // Oldest -> newest; the last entry is the still-filling current hour.
  return counts.map((c, i) => ({ t: `2026-06-03T${String(i).padStart(2, '0')}:00:00Z`, c }))
}

function stat(partial: Partial<ReportStat>): ReportStat {
  return {
    provider: 'codex',
    count_1h: 0,
    count_24h: 0,
    symptom_breakdown: {},
    hourly_buckets: [],
    ...partial,
  }
}

describe('baselineFromBuckets', () => {
  it('returns 0 with no history', () => {
    expect(baselineFromBuckets([])).toBe(0)
    expect(baselineFromBuckets(buckets([5]))).toBe(0) // only the current hour
  })

  it('ignores the current (last) bucket and medians the rest', () => {
    // prior = [2,4,6] -> median 4; last bucket (99) excluded
    expect(baselineFromBuckets(buckets([2, 4, 6, 99]))).toBe(4)
  })

  it('averages the middle two for an even count of prior buckets', () => {
    // prior = [2,4,6,8] -> median (4+6)/2 = 5
    expect(baselineFromBuckets(buckets([2, 4, 6, 8, 99]))).toBe(5)
  })
})

describe('deriveStatus', () => {
  it('is normal when volume is low even if ratio is high', () => {
    // current 3 is below elevatedFloor (4) despite huge ratio vs baseline 0
    const read = deriveStatus(stat({ count_1h: 3, hourly_buckets: buckets([0, 0, 0, 3]) }))
    expect(read.tier).toBe('normal')
  })

  it('is normal when ratio is low even if volume is high', () => {
    // baseline 50, current 55 -> ratio ~1.1, not elevated
    const read = deriveStatus(stat({ count_1h: 55, hourly_buckets: buckets([50, 50, 50, 55]) }))
    expect(read.tier).toBe('normal')
  })

  it('flags elevated above floor and 2x baseline', () => {
    // baseline 3, current 6 -> ratio 2, floor 4 met
    const read = deriveStatus(stat({ count_1h: 6, hourly_buckets: buckets([3, 3, 3, 6]) }))
    expect(read.tier).toBe('elevated')
  })

  it('flags spike above spike floor and 4x baseline', () => {
    // baseline 2, current 10 -> ratio 5, floor 8 met
    const read = deriveStatus(stat({ count_1h: 10, hourly_buckets: buckets([2, 2, 2, 10]) }))
    expect(read.tier).toBe('spike')
  })

  it('does not spike on high ratio if below spike floor', () => {
    // baseline 1, current 6 -> ratio 6 (>=4) but current 6 < spikeFloor 8 => elevated
    const read = deriveStatus(stat({ count_1h: 6, hourly_buckets: buckets([1, 1, 1, 6]) }))
    expect(read.tier).toBe('elevated')
  })

  it('respects custom thresholds', () => {
    const read = deriveStatus(
      stat({ count_1h: 5, hourly_buckets: buckets([1, 1, 1, 5]) }),
      { ...DEFAULT_THRESHOLDS, spikeFloor: 5, spikeMult: 3 },
    )
    expect(read.tier).toBe('spike')
  })
})

describe('topSymptoms', () => {
  it('orders by count desc and drops zeros', () => {
    const result = topSymptoms(
      stat({ symptom_breakdown: { slow: 2, errors: 5, limits: 0, quality: 3 } }),
    )
    expect(result.map((s) => s.id)).toEqual(['errors', 'quality', 'slow'])
  })

  it('respects the limit', () => {
    const result = topSymptoms(
      stat({ symptom_breakdown: { slow: 2, errors: 5, quality: 3 } }),
      2,
    )
    expect(result).toHaveLength(2)
  })
})

describe('tierIsWorse', () => {
  it('ranks spike > elevated > normal', () => {
    expect(tierIsWorse('spike', 'elevated')).toBe(true)
    expect(tierIsWorse('elevated', 'normal')).toBe(true)
    expect(tierIsWorse('normal', 'spike')).toBe(false)
    expect(tierIsWorse('elevated', 'elevated')).toBe(false)
  })
})
