import type { CompanyId, Event } from './data'

export type Prediction = {
  company: CompanyId
  companyLabel: string
  score: number
  label: 'low' | 'watch' | 'likely' | 'hot'
  nextWindow: string
  drivers: string[]
  blockers: string[]
  matchedEvents: Event[]
}

const daysBetween = (a: string, b: string) => {
  const ms = new Date(b).getTime() - new Date(a).getTime()
  return ms / 86_400_000
}

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

export function classify(score: number): Prediction['label'] {
  if (score >= 78) return 'hot'
  if (score >= 58) return 'likely'
  if (score >= 35) return 'watch'
  return 'low'
}

export function predictionWindow(score: number) {
  if (score >= 78) return '0–72h after root cause/fix'
  if (score >= 58) return '1–7 days after incident resolution'
  if (score >= 35) return 'Only if user reports keep clustering'
  return 'No reset expected from public signals'
}

export function buildPredictions(events: Event[]): Prediction[] {
  const companies: CompanyId[] = ['anthropic', 'openai']
  return companies.map((company) => {
    const companyEvents = events.filter((event) => event.company === company)
    const recent = companyEvents.slice().sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp)).slice(0, 4)
    const weighted = recent.map((event, index) => eventResetProbability(event) * (1 - index * 0.13))
    const score = Math.round(weighted.reduce((sum, value) => sum + value, 0) / Math.max(1, weighted.length))
    const drivers = recent.flatMap((event) => {
      const d: string[] = []
      if (event.usageRelated) d.push(`${event.title}: usage/limit language present`)
      if (event.rootCauseKnown) d.push(`${event.title}: root cause/fix known`)
      if (event.kind === 'metering-bug') d.push(`${event.title}: direct metering bug`)
      if (event.resetIssued) d.push(`${event.title}: historical reset precedent`)
      return d
    }).slice(0, 5)
    const blockers = [
      recent.some((event) => !event.usageRelated) ? 'Some recent incidents are generic availability/latency, which rarely force resets.' : '',
      recent.some((event) => event.evidence === 'community') ? 'Some evidence is repost/community-level rather than original official source.' : '',
      'A reset remains a policy/support decision; public telemetry cannot guarantee it.',
    ].filter(Boolean)

    return {
      company,
      companyLabel: company === 'anthropic' ? 'Anthropic' : 'OpenAI',
      score,
      label: classify(score),
      nextWindow: predictionWindow(score),
      drivers: drivers.length ? drivers : ['No strong current drivers.'],
      blockers,
      matchedEvents: recent,
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
