export type CompanyId = 'anthropic' | 'openai'
export type EventKind = 'outage' | 'metering-bug' | 'latency' | 'capacity' | 'policy-change' | 'reset'
export type EvidenceStrength = 'official' | 'employee' | 'community' | 'inferred'

export type Event = {
  id: string
  company: CompanyId
  companyLabel: string
  product: string
  kind: EventKind
  title: string
  timestamp: string
  resolvedAt?: string
  severity: 1 | 2 | 3 | 4 | 5
  userImpact: string
  rootCauseKnown: boolean
  usageRelated: boolean
  resetIssued: boolean
  resetAt?: string
  resetScope?: string
  // Confidence of the matched reset announcement, independent of the incident's
  // own `evidence` (live status events are always `official` for the incident,
  // but the reset that follows can be community/inferred).
  resetConfidence?: EvidenceStrength
  evidence: EvidenceStrength
  sourceLabel: string
  sourceUrl?: string
  notes: string
}

export type Company = {
  id: CompanyId
  name: string
  products: string[]
  statusUrl: string
  resetChannels: string[]
  publicSignalQuality: number
}

export const companies: Company[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    products: ['Claude Code', 'Claude.ai', 'Claude API'],
    statusUrl: 'https://status.claude.com',
    resetChannels: ['Claude Code team posts', 'Anthropic engineers on X', 'status.claude.com'],
    publicSignalQuality: 74,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    products: ['Codex', 'ChatGPT', 'OpenAI API'],
    statusUrl: 'https://status.openai.com',
    resetChannels: ['Codex team posts', 'OpenAI status page', 'OpenAI community reports'],
    publicSignalQuality: 62,
  },
]

export const events: Event[] = [
  {
    id: 'claude-cache-bug-2026-02',
    company: 'anthropic',
    companyLabel: 'Anthropic',
    product: 'Claude Code',
    kind: 'metering-bug',
    title: 'Prompt caching bug consumed Claude Code limits too quickly',
    timestamp: '2026-02-25T18:00:00Z',
    resolvedAt: '2026-02-26T16:00:00Z',
    severity: 4,
    userImpact: 'Heavy users hit 5-hour/session ceilings much sooner than expected.',
    rootCauseKnown: true,
    usageRelated: true,
    resetIssued: true,
    resetAt: '2026-02-26T18:00:00Z',
    resetScope: 'All Claude Code users',
    evidence: 'employee',
    sourceLabel: 'Public Claude Code team post',
    sourceUrl: 'https://x.com/trq212/status/2027232172810416493',
    notes: 'This is the cleanest known example: a metering/root-cause bug followed by a broad rate-limit reset.',
  },
  {
    id: 'claude-postmortem-2026-04',
    company: 'anthropic',
    companyLabel: 'Anthropic',
    product: 'Claude Code',
    kind: 'metering-bug',
    title: 'Subscriber limits reset after multi-fix Claude Code postmortem',
    timestamp: '2026-04-23T12:00:00Z',
    severity: 3,
    userImpact: 'Subscribers reported unexpected limit drain and inconsistent usage behavior.',
    rootCauseKnown: true,
    usageRelated: true,
    resetIssued: true,
    resetAt: '2026-04-23T18:00:00Z',
    resetScope: 'Claude Code subscribers',
    evidence: 'community',
    sourceLabel: 'Secondary public repost; original source not yet captured',
    notes: 'Track as lower-confidence until the original announcement or status entry is found.',
  },
  {
    id: 'codex-rate-limit-2026-05-22',
    company: 'openai',
    companyLabel: 'OpenAI',
    product: 'Codex',
    kind: 'metering-bug',
    title: 'Increase in users hitting Codex rate limits',
    timestamp: '2026-05-22T16:37:50Z',
    resolvedAt: '2026-05-23T10:58:21Z',
    severity: 4,
    userImpact: 'Users exhausted hourly/weekly Codex allowance faster than normal.',
    rootCauseKnown: false,
    usageRelated: true,
    resetIssued: true,
    resetAt: '2026-05-31T15:00:00Z',
    resetScope: 'All paid ChatGPT subscriptions; weekly and hourly Codex limits back to 100%',
    evidence: 'official',
    sourceLabel: 'OpenAI status incident + Codex team reset post',
    sourceUrl: 'https://status.openai.com',
    notes: 'Attribution is plausible but not perfect: reset post was public and broad, not phrased as an explicit apology.',
  },
  {
    id: 'codex-compaction-2026-05-27',
    company: 'openai',
    companyLabel: 'OpenAI',
    product: 'Codex',
    kind: 'latency',
    title: 'Codex context compaction latency',
    timestamp: '2026-05-27T17:57:17Z',
    resolvedAt: '2026-05-28T06:59:35Z',
    severity: 2,
    userImpact: 'Long-running Codex sessions slowed during context compaction.',
    rootCauseKnown: true,
    usageRelated: false,
    resetIssued: true,
    resetAt: '2026-05-31T15:00:00Z',
    resetScope: 'All paid ChatGPT subscriptions; weekly and hourly Codex limits back to 100%',
    evidence: 'official',
    sourceLabel: 'OpenAI status incident + Codex team reset post',
    sourceUrl: 'https://status.openai.com',
    notes: 'May be adjacent rather than causal. The score model weights this lower than direct quota bugs.',
  },
  {
    id: 'claude-sonnet-errors-2026-06-01',
    company: 'anthropic',
    companyLabel: 'Anthropic',
    product: 'Claude Code / Claude API',
    kind: 'outage',
    title: 'Elevated errors on Claude Sonnet models',
    timestamp: '2026-06-01T14:40:00Z',
    resolvedAt: '2026-06-01T19:06:00Z',
    severity: 2,
    userImpact: 'Transient elevated errors across Claude surfaces.',
    rootCauseKnown: false,
    usageRelated: false,
    resetIssued: false,
    evidence: 'official',
    sourceLabel: 'status.claude.com incident stream',
    sourceUrl: 'https://status.claude.com',
    notes: 'General availability incidents are less predictive unless they waste paid quota or cause many failed coding runs.',
  },
]

export const failurePoints = [
  {
    title: 'Official status pages omit the reset',
    detail: 'Resets are often announced by product engineers or reposted by users, not attached to the official incident.',
    mitigation: 'Track official incidents and public reset mentions separately, then compare timing, product, and scope.',
  },
  {
    title: 'Celebration resets look like apology resets',
    detail: 'Some resets are framed as promos or “let the tokens rip,” even when users believe they followed an outage.',
    mitigation: 'Classify attribution separately: explicit, likely, adjacent, unrelated.',
  },
  {
    title: 'Private/account-specific limits are invisible',
    detail: 'Companies may quietly credit subsets of users without public posts.',
    mitigation: 'Accept user reports, but keep them lower confidence until several people report the same pattern.',
  },
  {
    title: 'Time zones and deleted posts distort lag',
    detail: 'X posts, status updates, and community screenshots may disagree or disappear.',
    mitigation: 'Keep durable source links where possible and compare every event in one timezone.',
  },
  {
    title: 'Model or plan changes masquerade as incidents',
    detail: 'A policy rollout can increase consumption without being an outage.',
    mitigation: 'Weight direct metering words — quota, usage, rate limit, consumed — above generic latency/error terms.',
  },
  {
    title: 'Prediction can become wishcasting',
    detail: 'A reset is a business decision, not a natural law.',
    mitigation: 'Display confidence bands, not countdowns, and show the signals behind the score.',
  },
]

export const watchlistSignals = [
  'Official status incidents with quota, metering, compaction, or root-cause language — not generic “elevated errors” alone.',
  'Public chatter clusters on X, forums, and social — pain terms and reset terms are scored separately.',
  'Crowdsourced “is it down?” reports compared to a normal hourly baseline; weekly totals never drive the live tier.',
  'Reset odds and pain index stay separate — developers feeling it does not automatically mean a make-good reset is coming.',
]
