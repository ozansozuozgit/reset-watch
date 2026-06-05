import type { ProviderId, ReportStat, SymptomId } from './reports'

// Pure status derivation. No network, no React — unit-testable in isolation.
// Downdetector-style: compare the current hour to a rolling baseline, require
// sustained elevation before "Problems" (spike), and never let weekly totals
// or community pain alone read as a report spike.

export type StatusTier = 'normal' | 'elevated' | 'spike'

export type Thresholds = {
  elevatedFloor: number // min current-hour reports to be 'elevated'
  elevatedMult: number // min current/baseline ratio to be 'elevated'
  spikeFloor: number // min current-hour reports to be 'spike'
  spikeMult: number // min current/baseline ratio to be 'spike'
  spikeStrongMult: number // instant spike without duration when count * ratio both extreme
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  elevatedFloor: 4,
  elevatedMult: 2,
  spikeFloor: 8,
  spikeMult: 4,
  spikeStrongMult: 1.5, // count >= spikeFloor * 1.5 skips duration gate
}

export type StatusRead = {
  tier: StatusTier
  instant: StatusTier // raw volume vs baseline, before duration gate
  current: number // reports in the last hour
  baseline: number // median of prior completed hourly buckets
  ratio: number // current / max(baseline, 1)
  sustainedHours: number // how many of the last 4 buckets were elevated+
}

// Median of the completed prior hourly buckets (everything except the most
// recent bucket, which is still filling). Returns 0 when there is no history.
export function baselineFromBuckets(buckets: { t: string; c: number }[]): number {
  if (buckets.length <= 1) return 0
  const prior = sortedBuckets(buckets)
    .slice(0, -1)
    .map((b) => b.c)
  if (prior.length === 0) return 0
  const sorted = prior.slice().sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function sortedBuckets(buckets: { t: string; c: number }[]): { t: string; c: number }[] {
  return buckets.slice().sort((a, b) => (a.t < b.t ? -1 : 1))
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = values.slice().sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

// Raw tier from a single hour's count vs its baseline — no duration gate.
export function instantReportTier(
  current: number,
  baseline: number,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): StatusTier {
  const ratio = current / Math.max(baseline, 1)
  if (current >= thresholds.spikeFloor && ratio >= thresholds.spikeMult) return 'spike'
  if (current >= thresholds.elevatedFloor && ratio >= thresholds.elevatedMult) return 'elevated'
  return 'normal'
}

// How many of the last `window` hourly buckets (including current) were elevated+.
export function sustainedElevatedHours(
  buckets: { t: string; c: number }[],
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
  window = 4,
): number {
  const sorted = sortedBuckets(buckets)
  if (sorted.length === 0) return 0
  const slice = sorted.slice(-window)
  const offset = sorted.length - slice.length
  let elevated = 0
  for (let i = 0; i < slice.length; i++) {
    const priorCounts = sorted.slice(0, offset + i).map((b) => b.c)
    const baseline = median(priorCounts)
    if (instantReportTier(slice[i].c, baseline, thresholds) !== 'normal') elevated++
  }
  return elevated
}

export function deriveStatus(stat: ReportStat, thresholds: Thresholds = DEFAULT_THRESHOLDS): StatusRead {
  const current = stat.count_1h
  const baseline = baselineFromBuckets(stat.hourly_buckets)
  const ratio = current / Math.max(baseline, 1)
  const instant = instantReportTier(current, baseline, thresholds)
  const sustainedHours = sustainedElevatedHours(stat.hourly_buckets, thresholds)

  // Downdetector-style duration: "Problems" needs sustained evidence or an
  // overwhelming single-hour spike. Otherwise show "Possible problems".
  const strongSpike =
    instant === 'spike'
    && current >= thresholds.spikeFloor * thresholds.spikeStrongMult
    && ratio >= thresholds.spikeMult

  let tier: StatusTier = 'normal'
  if (instant === 'spike' && (sustainedHours >= 2 || strongSpike)) {
    tier = 'spike'
  } else if (instant !== 'normal') {
    tier = 'elevated'
  }

  return { tier, instant, current, baseline, ratio, sustainedHours }
}

const TIER_RANK: Record<StatusTier, number> = { normal: 0, elevated: 1, spike: 2 }

export function tierIsWorse(a: StatusTier, b: StatusTier): boolean {
  return TIER_RANK[a] > TIER_RANK[b]
}

export function worstTier(tiers: StatusTier[]): StatusTier {
  return tiers.reduce<StatusTier>((worst, tier) => (tierIsWorse(tier, worst) ? tier : worst), 'normal')
}

// Top symptoms (by count, desc) from a stat's last-hour breakdown.
export function topSymptoms(stat: ReportStat, limit = 3): { id: SymptomId; count: number }[] {
  return Object.entries(stat.symptom_breakdown)
    .map(([id, count]) => ({ id: id as SymptomId, count }))
    .filter((s) => s.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
}

export const TIER_COPY: Record<StatusTier, { label: string; section: string }> = {
  normal: { label: 'Normal', section: 'All quiet right now' },
  elevated: { label: 'Possible problems', section: 'Elevated — worth a look' },
  spike: { label: 'Problems', section: 'A tool is struggling right now' },
}

// What signal drove the corroborated condition. 'none' means everything is quiet.
export type ConditionDriver = 'reports' | 'pain' | 'incident' | 'none'

export type Condition = {
  tier: StatusTier
  driver: ConditionDriver
  reportsPerHour: number
}

// Community pain can corroborate "possible problems" but never "problems" on its
// own — only crowdsourced report spikes earn the top tier (matches Downdetector).
export function painTier(pain: number): StatusTier {
  if (pain >= 58) return 'elevated'
  return 'normal'
}

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

export const INCIDENT_HEAT_FLOOR = 60
export const ELEVATED_REPORTS_HEAT_FLOOR = 60
export const SPIKE_REPORTS_HEAT_FLOOR = 80

export function effectiveHeat(args: {
  chatterHeat: number
  officialIncident: boolean
  reportTier: StatusTier
}): number {
  const floors = [args.chatterHeat]
  if (args.officialIncident) floors.push(INCIDENT_HEAT_FLOOR)
  if (args.reportTier === 'spike') floors.push(SPIKE_REPORTS_HEAT_FLOOR)
  else if (args.reportTier === 'elevated') floors.push(ELEVATED_REPORTS_HEAT_FLOOR)
  return Math.max(0, Math.min(100, Math.round(Math.max(...floors))))
}

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

export function emptyReportStat(providerId: ProviderId): ReportStat {
  return {
    provider: providerId,
    count_1h: 0,
    count_24h: 0,
    count_7d: 0,
    symptom_breakdown: {},
    hourly_buckets: [],
  }
}

export type ProviderLiveRead = {
  providerId: ProviderId
  stat: ReportStat
  report: StatusRead
  blended: Condition
  pain?: number
}

export type CardTrafficDisplay = {
  value: number | string
  label: string
  hint: string
}

export function buildProviderLiveRead(args: {
  providerId: ProviderId
  stat: ReportStat
  pain?: number
  officialIncident: boolean
}): ProviderLiveRead {
  return {
    providerId: args.providerId,
    stat: args.stat,
    report: deriveStatus(args.stat),
    blended: blendCondition({
      stat: args.stat,
      pain: args.pain,
      officialIncident: args.officialIncident,
    }),
    pain: args.pain,
  }
}

export function buildPrimaryProviderReads(args: {
  stats: ReportStat[]
  painByProvider: Partial<Record<ProviderId, number>>
  corroboration: Partial<Record<ProviderId, string>>
}): ProviderLiveRead[] {
  const byProvider = new Map(args.stats.map((s) => [s.provider, s]))
  return PROVIDERS_PRIMARY.map((providerId) => {
    const stat = byProvider.get(providerId) ?? emptyReportStat(providerId)
    return buildProviderLiveRead({
      providerId,
      stat,
      pain: args.painByProvider[providerId],
      officialIncident: Boolean(args.corroboration[providerId]),
    })
  })
}

// Primary hero tools — kept in display order for tests, ranked at read time.
const PROVIDERS_PRIMARY: ProviderId[] = ['codex', 'claude-code']

export function rankProviderReads(reads: ProviderLiveRead[]): ProviderLiveRead[] {
  return reads.slice().sort((a, b) => compareReportUrgency(b.stat, a.stat))
}

export function liveStatusNote(read: ProviderLiveRead, incidentName?: string): string | null {
  const { report, blended } = read
  if (blended.driver === 'incident') {
    return incidentName ? `Official incident: ${incidentName}` : 'Official incident active'
  }
  if (report.tier === 'normal' && blended.driver === 'pain') {
    return 'High community pain — no report spike yet'
  }
  if (report.tier !== 'normal' && blended.driver === 'pain') {
    return 'Report spike plus elevated community pain'
  }
  if (report.tier === 'elevated' && report.instant === 'spike') {
    return 'Spike building — needs another elevated hour to confirm'
  }
  return null
}

// When the last hour is quiet, lead with 24h volume so low-traffic cards still
// feel alive — without letting weekly totals imply a live spike.
export function cardTrafficDisplay(stat: ReportStat, tier: StatusTier): CardTrafficDisplay {
  const quietHour = tier === 'normal' && stat.count_1h < 2
  if (quietHour && stat.count_24h > 0) {
    return {
      value: stat.count_24h,
      label: 'reports in 24h',
      hint: `${stat.count_1h} in the last hour`,
    }
  }
  if (quietHour) {
    return {
      value: '—',
      label: 'quiet right now',
      hint: 'Tap below if you see an issue',
    }
  }
  return {
    value: stat.count_1h,
    label: 'reports last hour',
    hint: `${stat.count_24h} in 24h`,
  }
}

// Older weekly volume, de-emphasized so it adds context without looking live.
export function historyChip(stat: ReportStat): string | null {
  const older = (stat.count_7d ?? 0) - stat.count_24h
  if (older < 5) return null
  return `+${older} earlier this week`
}

export type ReportLead = {
  providerId: ProviderId
  reportTier: StatusTier
  stat: ReportStat
}

export function compareReportUrgency(a: ReportStat, b: ReportStat): number {
  const ra = deriveStatus(a)
  const rb = deriveStatus(b)
  if (TIER_RANK[ra.tier] !== TIER_RANK[rb.tier]) return TIER_RANK[ra.tier] - TIER_RANK[rb.tier]
  if (TIER_RANK[ra.instant] !== TIER_RANK[rb.instant]) return TIER_RANK[ra.instant] - TIER_RANK[rb.instant]
  if (a.count_1h !== b.count_1h) return b.count_1h - a.count_1h
  return b.count_24h - a.count_24h
}

export function pickReportLead(entries: { providerId: ProviderId; stat: ReportStat }[]): ReportLead | null {
  if (entries.length === 0) return null
  const sorted = entries.slice().sort((a, b) => compareReportUrgency(b.stat, a.stat))
  const top = sorted[0]
  const reportTier = deriveStatus(top.stat).tier
  if (reportTier === 'normal') return null
  return { providerId: top.providerId, reportTier, stat: top.stat }
}

export function pickReportLeadFromReads(reads: ProviderLiveRead[]): ReportLead | null {
  return pickReportLead(reads.map((r) => ({ providerId: r.providerId, stat: r.stat })))
}

// Page-level live pill: report spikes win; pain/incidents cap at elevated.
export function pageLiveCondition(reads: ProviderLiveRead[]): StatusTier {
  return worstTier(reads.map((r) => r.blended.tier))
}
