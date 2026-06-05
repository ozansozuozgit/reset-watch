import type { CompanyId, EvidenceStrength, Event } from './data'
import { socialTopicForCompany, type SocialSnapshot, type SocialTopic } from './live'

export type Prediction = {
  company: CompanyId
  companyLabel: string
  score: number
  resetScore: number
  painScore: number
  label: 'low' | 'watch' | 'likely' | 'hot'
  painLabel: 'quiet' | 'noticeable' | 'degraded' | 'burning'
  nextWindow: string
  drivers: string[]
  blockers: string[]
  painDrivers: string[]
  socialTopic?: SocialTopic
  matchedEvents: Event[]
  // When a reset has already landed, the forecast stops predicting and reports
  // it as confirmed instead — otherwise the card shows a stale "likely reset"
  // for a thing that already happened.
  resetConfirmed: boolean
  resetConfirmedAt?: string
  resetConfirmedScope?: string
  resetConfirmedSource?: string
  resetConfirmedConfidence?: EvidenceStrength
}

// How long a reset stays "freshly confirmed" before the card returns to its
// normal predictive read.
export const RESET_FRESH_HOURS = 24
// How many "my limits just reset" reports (in the last hour) it takes to call a
// community-confirmed reset on their own, with no curated announcement.
export const COMMUNITY_RESET_THRESHOLD = 3
// Pain relief outlasts the "Reset ✓" status window: a make-good eases developer
// sentiment for longer than the reset stays headline-fresh, and the keyword
// scanner is slow to register that relief. So the pain discount tapers to zero
// over this (longer) window — measured from the reset — even after the status
// has already flipped back to its predictive read at RESET_FRESH_HOURS.
export const RESET_PAIN_RELIEF_HOURS = 48

// Full pain discount at the moment of a reset, before tapering. The keyword
// scanner lags real sentiment after a make-good (relief posts are quieter than
// outrage, positive terms barely offset, and the search window still holds days
// of pre-reset anger). A reset is real evidence the mood is turning that the
// scanner can't see yet, so we discount pain — more when it is strongly attested.
const RESET_PAIN_RELIEF: Record<EvidenceStrength, number> = {
  official: 24,
  employee: 22,
  community: 14,
  inferred: 10,
}

// Apply post-reset relief to a raw pain score. The discount tapers linearly from
// its full value at the moment of the reset to zero at RESET_PAIN_RELIEF_HOURS,
// so it stays visible for a while after the "Reset ✓" status expires. Returns the
// unchanged score when there is no recent reset. Never drops below 0.
export function relievedPain(
  pain: number,
  reset: ConfirmedReset | null,
  now: string = new Date().toISOString(),
): number {
  if (!reset) return pain
  const ageHours = (new Date(now).getTime() - new Date(reset.at).getTime()) / 3_600_000
  const taper = Math.max(0, Math.min(1, 1 - ageHours / RESET_PAIN_RELIEF_HOURS))
  return Math.max(0, Math.round(pain - RESET_PAIN_RELIEF[reset.confidence] * taper))
}

const CONFIDENCE_RANK: Record<EvidenceStrength, number> = {
  official: 4,
  employee: 3,
  community: 2,
  inferred: 1,
}

export type ResetSignal = { communityResetReports?: number }

export type ConfirmedReset = {
  at: string
  scope?: string
  source: string
  confidence: EvidenceStrength
}

// Decide whether a reset has actually happened for a company, from two sources:
// (1) a fresh curated/announced reset matched to a recent incident, and
// (2) a cluster of crowdsourced "my limits just reset" reports. The strongest
// available confidence wins.
export function detectConfirmedReset(
  recent: Event[],
  signal?: ResetSignal,
  now: string = new Date().toISOString(),
  withinHours: number = RESET_FRESH_HOURS,
): ConfirmedReset | null {
  const nowMs = new Date(now).getTime()
  const freshMs = withinHours * 3_600_000
  const candidates: ConfirmedReset[] = []

  for (const event of recent) {
    if (!event.resetIssued || !event.resetAt) continue
    const ageMs = nowMs - new Date(event.resetAt).getTime()
    // Within the freshness window and not implausibly in the future.
    if (ageMs < -3_600_000 || ageMs > freshMs) continue
    candidates.push({
      at: event.resetAt,
      scope: event.resetScope,
      source: `${event.companyLabel} status / announcement`,
      confidence: event.resetConfidence ?? event.evidence,
    })
  }

  const communityReports = signal?.communityResetReports ?? 0
  if (communityReports >= COMMUNITY_RESET_THRESHOLD) {
    candidates.push({
      at: now,
      scope: `${communityReports} crowdsourced reset reports in the last hour`,
      source: 'Crowdsourced reports',
      confidence: 'community',
    })
  }

  if (!candidates.length) return null
  return candidates.sort(
    (a, b) =>
      CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence] ||
      new Date(b.at).getTime() - new Date(a.at).getTime(),
  )[0]
}

const clamp = (value: number, min = 0, max = 100) => Math.max(min, Math.min(max, value))

const daysBetween = (a: string, b: string) => {
  const ms = new Date(b).getTime() - new Date(a).getTime()
  return ms / 86_400_000
}

const isActive = (event: Event) => !event.resolvedAt && daysBetween(event.timestamp, new Date().toISOString()) <= 14

export function lagHours(event: Event) {
  if (!event.resetAt) return null
  const anchor = event.resolvedAt ?? event.timestamp
  return Math.round(((new Date(event.resetAt).getTime() - new Date(anchor).getTime()) / 3_600_000) * 10) / 10
}

export function eventResetProbability(event: Event) {
  let score = 8
  if (event.usageRelated) score += 32
  if (event.kind === 'metering-bug') score += 24
  if (event.kind === 'outage') score += 6
  if (event.kind === 'latency') score += 4
  if (event.rootCauseKnown) score += 14
  score += event.severity * 4
  if (event.product.toLowerCase().includes('code') || event.product.toLowerCase().includes('codex')) score += 10
  if (event.evidence === 'community') score -= 8
  if (!event.usageRelated && event.severity <= 2) score -= 14
  return Math.max(3, Math.min(96, score))
}

export function eventPainScore(event: Event) {
  let score = 8 + event.severity * 12
  if (event.kind === 'outage') score += 18
  if (event.kind === 'latency') score += 16
  if (event.kind === 'capacity') score += 14
  if (event.kind === 'metering-bug') score += 22
  if (event.usageRelated) score += 18
  if (isActive(event)) score += 22
  if (event.product.toLowerCase().includes('code') || event.product.toLowerCase().includes('codex')) score += 8
  return clamp(score, 0, 100)
}

export function classify(score: number): Prediction['label'] {
  if (score >= 78) return 'hot'
  if (score >= 58) return 'likely'
  if (score >= 35) return 'watch'
  return 'low'
}

export function classifyPain(score: number): Prediction['painLabel'] {
  if (score >= 78) return 'burning'
  if (score >= 58) return 'degraded'
  if (score >= 35) return 'noticeable'
  return 'quiet'
}

export function predictionWindow(score: number) {
  if (score >= 78) return '0–72h after root cause/fix'
  if (score >= 58) return '1–7 days after incident resolution'
  if (score >= 35) return 'Only if user reports keep clustering'
  return 'No reset expected from public signals'
}

function companyBaseScore(recent: Event[]) {
  if (!recent.length) return 0
  const scores = recent.map(eventResetProbability)
  const max = Math.max(...scores)
  const weighted = scores.map((score, index) => score * (1 - index * 0.13))
  const average = weighted.reduce((sum, value) => sum + value, 0) / Math.max(1, weighted.length)
  return Math.round(max * 0.65 + average * 0.25)
}

export function companyPainScore(recent: Event[], socialTopic?: SocialTopic) {
  const eventScores = recent.map(eventPainScore)
  const officialPain = eventScores.length ? Math.max(...eventScores) : 0
  const avgPain = eventScores.length ? eventScores.reduce((sum, score) => sum + score, 0) / eventScores.length : 0
  const socialHeat = socialTopic?.heat ?? 0
  const socialPain = socialTopic?.pain_chatter ?? 0
  const blended = officialPain * 0.38 + avgPain * 0.17 + socialHeat * 0.25 + socialPain * 0.20
  // Responsive floor: when a real official incident AND loud community pain
  // corroborate each other, historical averaging must not drag the headline
  // (the most-viewed hero Pain Index) below what both strong signals agree on.
  // Uncorroborated community noise alone never trips this — it can't inflate the
  // forecast off a few loud posts.
  const corroborated = officialPain >= 50 && socialPain >= 58
  const floor = corroborated ? Math.min(officialPain, socialPain) : 0
  return Math.round(clamp(Math.max(blended, floor)))
}

export function buildPredictions(
  events: Event[],
  social?: SocialSnapshot | null,
  resetSignals?: Partial<Record<CompanyId, ResetSignal>>,
  now: string = new Date().toISOString(),
): Prediction[] {
  const companies: CompanyId[] = ['anthropic', 'openai']
  return companies.map((company) => {
    const companyEvents = events.filter((event) => event.company === company)
    const recent = companyEvents.slice().sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp)).slice(0, 4)
    const socialTopic = socialTopicForCompany(social, company)
    const confirmedReset = detectConfirmedReset(recent, resetSignals?.[company], now)
    // Relief uses the longer window so the pain discount keeps tapering even
    // after the "Reset ✓" status (RESET_FRESH_HOURS) has expired.
    const reliefReset = detectConfirmedReset(recent, resetSignals?.[company], now, RESET_PAIN_RELIEF_HOURS)
    const resetScore = Math.round(clamp(companyBaseScore(recent) + (socialTopic?.reset_chatter ?? 0) * 0.1))
    const rawPain = companyPainScore(recent, socialTopic)
    const painScore = relievedPain(rawPain, reliefReset, now)
    const label = classify(resetScore)
    const drivers = recent.flatMap((event) => {
      const d: string[] = []
      if (event.usageRelated) d.push(`${event.title}: usage/limit language present`)
      if (event.rootCauseKnown) d.push(`${event.title}: root cause/fix known`)
      if (event.kind === 'metering-bug') d.push(`${event.title}: direct metering bug`)
      if (event.resetIssued) d.push(`${event.title}: historical reset precedent`)
      return d
    })
    if ((socialTopic?.reset_chatter ?? 0) >= 35) {
      drivers.push(`${socialTopic?.product}: community reset/limit chatter is elevated`)
    }

    const painDrivers = recent.flatMap((event) => {
      const d: string[] = []
      if (isActive(event)) d.push(`${event.title}: active official incident`)
      if (event.severity >= 4) d.push(`${event.title}: major/critical impact`)
      if (event.kind === 'latency' || event.kind === 'outage') d.push(`${event.title}: availability or latency pain`)
      if (event.usageRelated) d.push(`${event.title}: limits/usage affected`)
      return d
    })
    if ((socialTopic?.heat ?? 0) >= 45) {
      painDrivers.push(`${socialTopic?.product}: community heat ${socialTopic?.heat}/100 from public chatter`)
    }
    if (reliefReset && rawPain > painScore) {
      painDrivers.push(`Pain discounted ${rawPain - painScore} pts: recent reset, sentiment expected to ease`)
    }

    const blockers = [
      recent.some((event) => !event.usageRelated) ? 'Some recent incidents are generic availability/latency, which rarely force resets.' : '',
      recent.some((event) => event.evidence === 'community') ? 'Some evidence comes from reposts or user reports rather than the original announcement.' : '',
      (socialTopic?.heat ?? 0) > 50 && (socialTopic?.reset_chatter ?? 0) < 35 ? 'Community pain is high, but reset-specific language is still weak.' : '',
      'A reset remains a policy/support decision; public telemetry cannot guarantee it.',
    ].filter(Boolean)

    return {
      company,
      companyLabel: company === 'anthropic' ? 'Anthropic' : 'OpenAI',
      score: resetScore,
      resetScore,
      painScore,
      label,
      painLabel: classifyPain(painScore),
      nextWindow: predictionWindow(resetScore),
      drivers: drivers.length ? drivers.slice(0, 5) : ['No strong current reset drivers.'],
      blockers,
      painDrivers: painDrivers.length ? painDrivers.slice(0, 5) : ['No strong current pain drivers.'],
      socialTopic,
      matchedEvents: recent,
      resetConfirmed: Boolean(confirmedReset),
      resetConfirmedAt: confirmedReset?.at,
      resetConfirmedScope: confirmedReset?.scope,
      resetConfirmedSource: confirmedReset?.source,
      resetConfirmedConfidence: confirmedReset?.confidence,
    }
  })
}

export function metrics(events: Event[]) {
  const codingEvents = events.filter((event) => event.product.toLowerCase().includes('code') || event.product.toLowerCase().includes('codex'))
  const usageEvents = codingEvents.filter((event) => event.usageRelated)
  const resets = codingEvents.filter((event) => event.resetIssued)
  const resetLags = resets.map(lagHours).filter((lag): lag is number => lag !== null && Number.isFinite(lag))
  const sortedLag = resetLags.slice().sort((a, b) => a - b)
  const medianLag = sortedLag.length ? sortedLag[Math.floor(sortedLag.length / 2)] : null

  return {
    codingIncidentCount: codingEvents.length,
    usageIncidentCount: usageEvents.length,
    resetCount: resets.length,
    makeGoodRate: Math.round((resets.length / Math.max(1, codingEvents.length)) * 100),
    usageMakeGoodRate: Math.round((usageEvents.filter((event) => event.resetIssued).length / Math.max(1, usageEvents.length)) * 100),
    medianLag,
  }
}

export function attribution(event: Event) {
  if (!event.resetIssued) return 'No reset observed'
  if (event.usageRelated && event.rootCauseKnown && event.kind === 'metering-bug') return 'Explicit/strong'
  if (event.usageRelated) return 'Likely'
  if (event.resetAt && daysBetween(event.resolvedAt ?? event.timestamp, event.resetAt) <= 7) return 'Adjacent'
  return 'Weak'
}
