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

// What signal drove the current condition. 'none' means everything is quiet.
export type ConditionDriver = 'reports' | 'pain' | 'incident' | 'none'

export type Condition = {
  tier: StatusTier
  driver: ConditionDriver
  reportsPerHour: number
}

// Map a 0-100 community pain score to a status tier (mirrors the site's
// existing score tones).
export function painTier(pain: number): StatusTier {
  if (pain >= 78) return 'spike'
  if (pain >= 58) return 'elevated'
  return 'normal'
}

// What the Community heat card should display. That card reads a single feed —
// public social chatter — but it must never declare "all calm" when a stronger,
// independent signal (an official incident or elevated on-site reports) says the
// product is struggling, or it contradicts the rest of the page.
//   - 'hot'         : social chatter is live → show the heat read.
//   - 'corroborated': social is quiet, but an incident / elevated reports are
//                     active → "quiet on social, but not all clear".
//   - 'calm'        : social is quiet AND nothing else is wrong → true all-clear.
// The official incident is the most concrete evidence, so it wins attribution
// over on-site reports when both are present.
export type CommunityHeatTone = 'hot' | 'corroborated' | 'calm'
export type CommunityHeatCorroborator = 'incident' | 'reports'

export type CommunityHeatRead = {
  tone: CommunityHeatTone
  corroboratedBy: CommunityHeatCorroborator | null
}

export function communityHeatRead(args: {
  socialQuiet: boolean
  officialIncident: boolean
  reportTier: StatusTier
}): CommunityHeatRead {
  if (!args.socialQuiet) return { tone: 'hot', corroboratedBy: null }
  if (args.officialIncident) return { tone: 'corroborated', corroboratedBy: 'incident' }
  if (args.reportTier !== 'normal') return { tone: 'corroborated', corroboratedBy: 'reports' }
  return { tone: 'calm', corroboratedBy: null }
}

// Blend crowdsourced reports with community pain and official incidents into
// one honest condition. We take the HIGHEST severity across signals, so a
// quiet report feed (0 reports — common with no traffic) can never pull the
// condition down to "normal" while pain or an official incident is elevated.
export function blendCondition(args: {
  stat?: ReportStat
  pain?: number
  officialIncident?: boolean
}): Condition {
  const reportTier = args.stat ? deriveStatus(args.stat).tier : 'normal'
  const candidates: { tier: StatusTier; driver: ConditionDriver }[] = [
    { tier: reportTier, driver: 'reports' },
    { tier: args.pain != null ? painTier(args.pain) : 'normal', driver: 'pain' },
    { tier: args.officialIncident ? 'elevated' : 'normal', driver: 'incident' },
  ]
  let best = candidates[0]
  for (const c of candidates) if (tierIsWorse(c.tier, best.tier)) best = c
  return {
    tier: best.tier,
    driver: best.tier === 'normal' ? 'none' : best.driver,
    reportsPerHour: args.stat?.count_1h ?? 0,
  }
}
