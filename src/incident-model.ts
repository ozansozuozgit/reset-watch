import type { ReportStat, SymptomId } from './reports'

// Pure status derivation. No network, no React — unit-testable in isolation.
// Turns crowdsourced report volume into a Downdetector-style status tier by
// comparing the current hour against a rolling baseline, with floors so that
// low-traffic noise can't trip a "spike".

export type StatusTier = 'normal' | 'elevated' | 'spike'

export type Thresholds = {
  elevatedFloor: number // min current-hour reports to be 'elevated'
  elevatedMult: number // min current/baseline ratio to be 'elevated'
  spikeFloor: number // min current-hour reports to be 'spike'
  spikeMult: number // min current/baseline ratio to be 'spike'
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  elevatedFloor: 4,
  elevatedMult: 2,
  spikeFloor: 8,
  spikeMult: 4,
}

export type StatusRead = {
  tier: StatusTier
  current: number // reports in the last hour
  baseline: number // median of prior completed hourly buckets
  ratio: number // current / max(baseline, 1)
}

// Median of the completed prior hourly buckets (everything except the most
// recent bucket, which is still filling). Returns 0 when there is no history.
export function baselineFromBuckets(buckets: { t: string; c: number }[]): number {
  if (buckets.length <= 1) return 0
  const prior = buckets
    .slice()
    .sort((a, b) => (a.t < b.t ? -1 : 1))
    .slice(0, -1)
    .map((b) => b.c)
  if (prior.length === 0) return 0
  const sorted = prior.slice().sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

export function deriveStatus(stat: ReportStat, thresholds: Thresholds = DEFAULT_THRESHOLDS): StatusRead {
  const current = stat.count_1h
  const baseline = baselineFromBuckets(stat.hourly_buckets)
  const ratio = current / Math.max(baseline, 1)

  let tier: StatusTier = 'normal'
  if (current >= thresholds.spikeFloor && ratio >= thresholds.spikeMult) {
    tier = 'spike'
  } else if (current >= thresholds.elevatedFloor && ratio >= thresholds.elevatedMult) {
    tier = 'elevated'
  }

  return { tier, current, baseline, ratio }
}

const TIER_RANK: Record<StatusTier, number> = { normal: 0, elevated: 1, spike: 2 }

export function tierIsWorse(a: StatusTier, b: StatusTier): boolean {
  return TIER_RANK[a] > TIER_RANK[b]
}

// Top symptoms (by count, desc) from a stat's last-hour breakdown.
export function topSymptoms(stat: ReportStat, limit = 3): { id: SymptomId; count: number }[] {
  return Object.entries(stat.symptom_breakdown)
    .map(([id, count]) => ({ id: id as SymptomId, count }))
    .filter((s) => s.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
}

export const TIER_COPY: Record<StatusTier, { label: string }> = {
  normal: { label: 'Normal' },
  elevated: { label: 'Elevated' },
  spike: { label: 'Spike' },
}
