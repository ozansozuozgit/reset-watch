import type { CompanyId, Event, EventKind } from './data'

export type StatusIncident = {
  source: CompanyId
  id: string
  name: string
  status: string
  impact?: 'none' | 'minor' | 'major' | 'critical' | string
  created_at?: string
  started_at?: string
  resolved_at?: string
  components?: string[]
  keyword_match?: boolean
  relevant_updates?: { status: string; created_at: string; body: string }[]
}

export type StatusSnapshot = {
  generated_at: string
  sources: { name: string; url: string; page?: string }[]
  incidents: StatusIncident[]
  errors: { name: string; url: string; message: string }[]
}

export type ResetAnnouncement = {
  id: string
  source: CompanyId
  product: string
  announced_at: string
  scope: string
  title: string
  url?: string
  confidence: 'official' | 'employee' | 'community' | 'inferred'
  matched_incident_keywords: string[]
}

export type ResetFeed = {
  generated_at: string
  resets: ResetAnnouncement[]
}

export type SocialExample = {
  source: string
  title: string
  url?: string
  published_at?: string
  matched_terms?: string[]
}

export type SocialTopic = {
  id: string
  company: CompanyId
  product: string
  heat: number
  sentiment: number
  volume: number
  pain_chatter: number
  reset_chatter: number
  top_terms: string[]
  sources: Record<string, number>
  examples: SocialExample[]
  notes: string[]
}

export type SocialSnapshot = {
  generated_at: string
  sources: { name: string; url: string }[]
  topics: SocialTopic[]
  errors: { topic?: string; source?: string; message: string }[]
}

const sourceLabel = (source: CompanyId) => source === 'anthropic' ? 'Anthropic' : 'OpenAI'

function inferProduct(incident: StatusIncident) {
  const text = `${incident.name} ${(incident.components ?? []).join(' ')}`.toLowerCase()
  if (text.includes('codex')) return 'Codex'
  if (text.includes('claude code')) return 'Claude Code'
  if (text.includes('claude')) return 'Claude Code / Claude API'
  return incident.source === 'openai' ? 'OpenAI coding surfaces' : 'Claude surfaces'
}

function inferKind(incident: StatusIncident): EventKind {
  const text = `${incident.name} ${(incident.relevant_updates ?? []).map((u) => u.body).join(' ')}`.toLowerCase()
  if (/rate limit|usage limit|quota|meter|consumed/.test(text)) return 'metering-bug'
  if (/latency|slow|performance|compaction|degraded|degradation/.test(text)) return 'latency'
  if (/capacity|overload/.test(text)) return 'capacity'
  if (/policy|plan|subscription/.test(text)) return 'policy-change'
  return 'outage'
}

function severityFromImpact(impact?: string): Event['severity'] {
  if (impact === 'critical') return 5
  if (impact === 'major') return 4
  if (impact === 'minor') return 2
  return 1
}

function impactText(incident: StatusIncident) {
  const update = incident.relevant_updates?.[0]?.body
  if (update) return update.replace(/\s+/g, ' ').slice(0, 180)
  return incident.name
}

function hasRootCause(incident: StatusIncident) {
  const text = `${incident.name} ${(incident.relevant_updates ?? []).map((u) => `${u.status} ${u.body}`).join(' ')}`.toLowerCase()
  return /identified|root cause|fix has been implemented|resolved|hotfix|rolled back/.test(text)
}

function isUsageRelated(incident: StatusIncident) {
  const text = `${incident.name} ${(incident.relevant_updates ?? []).map((u) => u.body).join(' ')}`.toLowerCase()
  return /rate limit|usage limit|quota|meter|consumed|reset/.test(text)
}

function findNearbyReset(incident: StatusIncident, resets: ResetAnnouncement[]) {
  const incidentTime = new Date(incident.resolved_at ?? incident.started_at ?? incident.created_at ?? 0).getTime()
  const product = inferProduct(incident).toLowerCase()
  return resets
    .filter((reset) => reset.source === incident.source)
    .map((reset) => ({ reset, lagMs: new Date(reset.announced_at).getTime() - incidentTime }))
    .filter(({ reset, lagMs }) => {
      const resetProduct = reset.product.toLowerCase()
      const productMatches = product.includes(resetProduct) || resetProduct.includes(product.split(' / ')[0])
      return productMatches && lagMs >= 0 && lagMs <= 7 * 86_400_000
    })
    .sort((a, b) => a.lagMs - b.lagMs)[0]?.reset
}

export function statusIncidentToEvent(incident: StatusIncident, resets: ResetAnnouncement[] = []): Event {
  const reset = findNearbyReset(incident, resets)
  const kind = inferKind(incident)
  const product = inferProduct(incident)
  return {
    id: `live-${incident.source}-${incident.id}`,
    company: incident.source,
    companyLabel: sourceLabel(incident.source),
    product,
    kind,
    title: incident.name,
    timestamp: incident.started_at ?? incident.created_at ?? new Date().toISOString(),
    resolvedAt: incident.resolved_at,
    severity: severityFromImpact(incident.impact),
    userImpact: impactText(incident),
    rootCauseKnown: hasRootCause(incident),
    usageRelated: isUsageRelated(incident),
    resetIssued: Boolean(reset),
    resetAt: reset?.announced_at,
    resetScope: reset?.scope,
    evidence: 'official',
    sourceLabel: `${sourceLabel(incident.source)} status page`,
    sourceUrl: incident.source === 'openai' ? 'https://status.openai.com' : 'https://status.claude.com',
    notes: reset ? `Matched to reset announcement: ${reset.title}` : 'Live status-page incident matched by coding/usage keywords.',
  }
}

export function liveEventsFromSnapshot(snapshot?: StatusSnapshot | null, resetFeed?: ResetFeed | null) {
  if (!snapshot?.incidents?.length) return []
  const resets = resetFeed?.resets ?? []
  return snapshot.incidents.map((incident) => statusIncidentToEvent(incident, resets))
}

export function mergeEvents(seedEvents: Event[], liveEvents: Event[]) {
  const seen = new Set<string>()
  return [...liveEvents, ...seedEvents].filter((event) => {
    const key = `${event.company}:${event.title}:${event.timestamp.slice(0, 10)}`.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function socialTopicForCompany(social: SocialSnapshot | null | undefined, company: CompanyId) {
  return social?.topics
    ?.filter((topic) => topic.company === company)
    .sort((a, b) => b.heat - a.heat)[0]
}

export async function loadJson<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(path, { cache: 'no-store' })
    if (!response.ok) return null
    return await response.json() as T
  } catch {
    return null
  }
}
