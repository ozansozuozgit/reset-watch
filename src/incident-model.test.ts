import { describe, expect, it } from 'vitest'
import {
  baselineFromBuckets,
  blendCondition,
  buildPrimaryProviderReads,
  communityHeatRead,
  compareReportUrgency,
  deriveStatus,
  effectiveHeat,
  instantReportTier,
  liveStatusNote,
  painTier,
  pickReportLead,
  sustainedElevatedHours,
  topSymptoms,
  tierIsWorse,
  cardTrafficDisplay,
  historyChip,
  DEFAULT_THRESHOLDS,
} from './incident-model'
import type { ReportStat } from './reports'

function buckets(counts: number[]): { t: string; c: number }[] {
  return counts.map((c, i) => ({ t: `2026-06-03T${String(i).padStart(2, '0')}:00:00Z`, c }))
}

function stat(partial: Partial<ReportStat>): ReportStat {
  return {
    provider: 'codex',
    count_1h: 0,
    count_24h: 0,
    count_7d: 0,
    symptom_breakdown: {},
    hourly_buckets: [],
    ...partial,
  }
}

describe('baselineFromBuckets', () => {
  it('returns 0 with no history', () => {
    expect(baselineFromBuckets([])).toBe(0)
    expect(baselineFromBuckets(buckets([5]))).toBe(0)
  })

  it('ignores the current (last) bucket and medians the rest', () => {
    expect(baselineFromBuckets(buckets([2, 4, 6, 99]))).toBe(4)
  })

  it('averages the middle two for an even count of prior buckets', () => {
    expect(baselineFromBuckets(buckets([2, 4, 6, 8, 99]))).toBe(5)
  })
})

describe('instantReportTier', () => {
  it('flags spike above spike floor and 4x baseline', () => {
    expect(instantReportTier(10, 2, DEFAULT_THRESHOLDS)).toBe('spike')
  })
})

describe('deriveStatus', () => {
  it('is normal when volume is low even if ratio is high', () => {
    const read = deriveStatus(stat({ count_1h: 3, hourly_buckets: buckets([0, 0, 0, 3]) }))
    expect(read.tier).toBe('normal')
  })

  it('is normal when ratio is low even if volume is high', () => {
    const read = deriveStatus(stat({ count_1h: 55, hourly_buckets: buckets([50, 50, 50, 55]) }))
    expect(read.tier).toBe('normal')
  })

  it('flags elevated above floor and 2x baseline', () => {
    const read = deriveStatus(stat({ count_1h: 6, hourly_buckets: buckets([3, 3, 3, 6]) }))
    expect(read.tier).toBe('elevated')
  })

  it('downgrades an isolated hourly spike to possible problems', () => {
    const read = deriveStatus(stat({ count_1h: 10, hourly_buckets: buckets([2, 2, 2, 10]) }))
    expect(read.instant).toBe('spike')
    expect(read.tier).toBe('elevated')
  })

  it('flags spike when elevation is sustained across hours', () => {
    const series = buckets([2, 2, 2, 10, 12, 14])
    const read = deriveStatus(stat({ count_1h: 14, hourly_buckets: series }))
    expect(read.tier).toBe('spike')
    expect(sustainedElevatedHours(series)).toBeGreaterThanOrEqual(2)
  })

  it('flags spike on an overwhelming single-hour burst', () => {
    const read = deriveStatus(stat({ count_1h: 16, hourly_buckets: buckets([1, 1, 1, 16]) }))
    expect(read.tier).toBe('spike')
  })

  it('does not spike on high ratio if below spike floor', () => {
    const read = deriveStatus(stat({ count_1h: 6, hourly_buckets: buckets([1, 1, 1, 6]) }))
    expect(read.tier).toBe('elevated')
  })

  it('respects custom thresholds', () => {
    const read = deriveStatus(
      stat({ count_1h: 8, hourly_buckets: buckets([1, 1, 1, 8]) }),
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

describe('painTier', () => {
  it('caps community pain at possible problems', () => {
    expect(painTier(20)).toBe('normal')
    expect(painTier(58)).toBe('elevated')
    expect(painTier(88)).toBe('elevated')
  })
})

describe('blendCondition', () => {
  it('does NOT report normal when reports are empty but pain is high', () => {
    const c = blendCondition({ stat: stat({ count_1h: 0 }), pain: 88 })
    expect(c.tier).toBe('elevated')
    expect(c.driver).toBe('pain')
    expect(c.reportsPerHour).toBe(0)
  })

  it('never marks pain alone as problems', () => {
    const c = blendCondition({ stat: stat({ count_1h: 0 }), pain: 99 })
    expect(c.tier).toBe('elevated')
    expect(c.tier).not.toBe('spike')
  })

  it('is normal only when every signal is quiet', () => {
    const c = blendCondition({ stat: stat({ count_1h: 0 }), pain: 10, officialIncident: false })
    expect(c.tier).toBe('normal')
    expect(c.driver).toBe('none')
  })

  it('an official incident raises a quiet feed to elevated', () => {
    const c = blendCondition({ stat: stat({ count_1h: 0 }), pain: 10, officialIncident: true })
    expect(c.tier).toBe('elevated')
    expect(c.driver).toBe('incident')
  })

  it('a sustained report spike still wins and is attributed to reports', () => {
    const c = blendCondition({
      stat: stat({ count_1h: 14, hourly_buckets: buckets([2, 2, 2, 10, 12, 14]) }),
      pain: 40,
    })
    expect(c.tier).toBe('spike')
    expect(c.driver).toBe('reports')
  })

  it('works with no stat at all', () => {
    expect(blendCondition({ pain: 88 }).tier).toBe('elevated')
    expect(blendCondition({}).tier).toBe('normal')
  })
})

describe('communityHeatRead', () => {
  it('is hot whenever social chatter is live, regardless of other signals', () => {
    const r = communityHeatRead({ socialQuiet: false, officialIncident: false, reportTier: 'normal' })
    expect(r.tone).toBe('hot')
    expect(r.corroboratedBy).toBeNull()
  })

  it('is calm only when social is quiet AND nothing else is wrong', () => {
    const r = communityHeatRead({ socialQuiet: true, officialIncident: false, reportTier: 'normal' })
    expect(r.tone).toBe('calm')
    expect(r.corroboratedBy).toBeNull()
  })

  it('does NOT read calm when social is quiet but an official incident is active', () => {
    const r = communityHeatRead({ socialQuiet: true, officialIncident: true, reportTier: 'normal' })
    expect(r.tone).toBe('corroborated')
    expect(r.corroboratedBy).toBe('incident')
  })

  it('does NOT read calm when social is quiet but on-site reports are elevated', () => {
    const r = communityHeatRead({ socialQuiet: true, officialIncident: false, reportTier: 'elevated' })
    expect(r.tone).toBe('corroborated')
    expect(r.corroboratedBy).toBe('reports')
  })

  it('attributes to the official incident when both an incident and reports are hot', () => {
    const r = communityHeatRead({ socialQuiet: true, officialIncident: true, reportTier: 'spike' })
    expect(r.tone).toBe('corroborated')
    expect(r.corroboratedBy).toBe('incident')
  })
})

describe('effectiveHeat', () => {
  it('passes raw chatter heat through when nothing corroborates', () => {
    expect(effectiveHeat({ chatterHeat: 30, officialIncident: false, reportTier: 'normal' })).toBe(30)
  })

  it('floors a zero-chatter topic to hot-topic territory during an official incident', () => {
    const h = effectiveHeat({ chatterHeat: 0, officialIncident: true, reportTier: 'normal' })
    expect(h).toBeGreaterThanOrEqual(58)
  })

  it('floors highest for a report spike, lower for elevated reports', () => {
    const spike = effectiveHeat({ chatterHeat: 0, officialIncident: false, reportTier: 'spike' })
    const elevated = effectiveHeat({ chatterHeat: 0, officialIncident: false, reportTier: 'elevated' })
    expect(spike).toBeGreaterThan(elevated)
    expect(elevated).toBeGreaterThanOrEqual(58)
  })

  it('keeps the higher value when chatter already exceeds the floor', () => {
    expect(effectiveHeat({ chatterHeat: 92, officialIncident: true, reportTier: 'spike' })).toBe(92)
  })

  it('clamps to 100', () => {
    expect(effectiveHeat({ chatterHeat: 130, officialIncident: false, reportTier: 'normal' })).toBe(100)
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

describe('compareReportUrgency', () => {
  it('prefers current spike over high weekly volume with quiet reports now', () => {
    const codex = stat({ count_1h: 1, count_24h: 4, count_7d: 154, hourly_buckets: buckets([2, 2, 2, 1]) })
    const claude = stat({
      provider: 'claude-code',
      count_1h: 9,
      count_24h: 22,
      count_7d: 38,
      hourly_buckets: buckets([1, 1, 2, 9]),
    })
    expect(compareReportUrgency(claude, codex)).toBeGreaterThan(0)
    expect(compareReportUrgency(codex, claude)).toBeLessThan(0)
  })
})

describe('pickReportLead', () => {
  it('returns the provider spiking on current reports, not weekly totals', () => {
    const lead = pickReportLead([
      { providerId: 'codex', stat: stat({ count_1h: 1, count_24h: 4, count_7d: 154, hourly_buckets: buckets([2, 2, 2, 1]) }) },
      {
        providerId: 'claude-code',
        stat: stat({
          provider: 'claude-code',
          count_1h: 9,
          count_24h: 22,
          count_7d: 38,
          hourly_buckets: buckets([1, 1, 2, 9]),
        }),
      },
    ])
    expect(lead?.providerId).toBe('claude-code')
    expect(lead?.reportTier).toBe('elevated')
  })

  it('returns null when nobody is elevated on current reports', () => {
    const lead = pickReportLead([
      { providerId: 'codex', stat: stat({ count_1h: 1, count_7d: 154, hourly_buckets: buckets([1, 1, 1, 1]) }) },
      { providerId: 'claude-code', stat: stat({ provider: 'claude-code', count_1h: 0, hourly_buckets: buckets([0, 0, 0, 0]) }) },
    ])
    expect(lead).toBeNull()
  })
})

describe('buildPrimaryProviderReads', () => {
  it('uses the same report tier everywhere for a provider', () => {
    const reads = buildPrimaryProviderReads({
      stats: [
        stat({ provider: 'codex', count_1h: 1, hourly_buckets: buckets([2, 2, 2, 1]) }),
        stat({
          provider: 'claude-code',
          count_1h: 9,
          count_24h: 22,
          hourly_buckets: buckets([1, 1, 2, 9]),
        }),
      ],
      painByProvider: { codex: 90 },
      corroboration: {},
    })
    const codex = reads.find((r) => r.providerId === 'codex')!
    const claude = reads.find((r) => r.providerId === 'claude-code')!
    expect(codex.report.tier).toBe('normal')
    expect(codex.blended.tier).toBe('elevated')
    expect(claude.report.tier).toBe('elevated')
    expect(liveStatusNote(claude)).toBe('Spike building — needs another elevated hour to confirm')
  })
})

describe('cardTrafficDisplay', () => {
  it('leads with 24h volume on quiet hours so cards do not look empty', () => {
    const display = cardTrafficDisplay(stat({ count_1h: 0, count_24h: 19 }), 'normal')
    expect(display.value).toBe(19)
    expect(display.label).toBe('reports in 24h')
    expect(display.hint).toMatch(/last hour/)
  })

  it('leads with the last hour when reports are active', () => {
    const display = cardTrafficDisplay(stat({ count_1h: 9, count_24h: 22 }), 'elevated')
    expect(display.value).toBe(9)
    expect(display.label).toBe('reports last hour')
  })
})

describe('historyChip', () => {
  it('shows older weekly volume without implying it is live', () => {
    expect(historyChip(stat({ count_24h: 19, count_7d: 154 }))).toBe('+135 earlier this week')
    expect(historyChip(stat({ count_24h: 20, count_7d: 22 }))).toBeNull()
  })
})
