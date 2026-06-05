import { mkdir, writeFile } from 'node:fs/promises'
import { pushSnapshot } from './lib/push-snapshot.mjs'

const sources = [
  ['openai', 'https://status.openai.com/api/v2/incidents.json'],
  ['anthropic', 'https://status.claude.com/api/v2/incidents.json'],
]

const keywords = /codex|claude code|rate limit|usage limit|quota|meter|compaction|cache|consumed|reset/i

// Tier 3 reset auto-detection: explicit "we reset / restored / credited" language
// that is also about usage/limits. Both must match to avoid false positives like
// "reset your password" or "service restored".
const resetLanguage = /\b(reset|restored|credited back|credited|re-?credited|make[- ]good|made good|refunded)\b/i
const usageContext = /\b(limit|limits|quota|quotas|usage|rate|allowance|allowances|credits?)\b/i

function inferProduct(source, name, components) {
  const text = `${name} ${components.join(' ')}`.toLowerCase()
  if (text.includes('codex')) return 'Codex'
  if (text.includes('claude code')) return 'Claude Code'
  if (text.includes('claude')) return 'Claude Code / Claude API'
  return source === 'openai' ? 'OpenAI coding surfaces' : 'Claude surfaces'
}

async function fetchJson(name, url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`${name} ${response.status} ${response.statusText}`)
  return response.json()
}

// Scan an incident's updates for an explicit reset announcement. Returns the
// first qualifying update as a low-confidence (`inferred`) reset entry, or null.
function detectReset(source, incident) {
  const components = incident.components?.map((component) => component.name) ?? []
  for (const update of incident.incident_updates ?? []) {
    const body = update.body ?? ''
    if (resetLanguage.test(body) && usageContext.test(body)) {
      return {
        id: `auto-${source}-${incident.id}`,
        source,
        product: inferProduct(source, incident.name, components),
        announced_at: update.created_at ?? incident.resolved_at ?? incident.created_at,
        scope: body.replace(/\s+/g, ' ').trim().slice(0, 200),
        title: incident.name,
        confidence: 'inferred',
        matched_incident_keywords: ['auto-detected reset language'],
      }
    }
  }
  return null
}

function summarizeIncident(source, incident) {
  const updates = incident.incident_updates ?? []
  const components = incident.components?.map((component) => component.name) ?? []
  const haystack = [incident.name, incident.impact, ...components, ...updates.map((update) => update.body)].join(' ')
  return {
    source,
    id: incident.id,
    name: incident.name,
    status: incident.status,
    impact: incident.impact,
    created_at: incident.created_at,
    started_at: incident.started_at,
    resolved_at: incident.resolved_at,
    components,
    keyword_match: keywords.test(haystack),
    relevant_updates: updates
      .filter((update) => keywords.test(update.body ?? ''))
      .map((update) => ({ status: update.status, created_at: update.created_at, body: update.body })),
  }
}

await mkdir('public/data', { recursive: true })

const snapshot = {
  generated_at: new Date().toISOString(),
  sources: [],
  incidents: [],
  errors: [],
}

const autoResets = []

for (const [name, url] of sources) {
  try {
    const data = await fetchJson(name, url)
    snapshot.sources.push({ name, url, page: data.page?.name })
    for (const incident of data.incidents ?? []) {
      snapshot.incidents.push(summarizeIncident(name, incident))
      const reset = detectReset(name, incident)
      if (reset) autoResets.push(reset)
    }
  } catch (error) {
    snapshot.errors.push({ name, url, message: error instanceof Error ? error.message : String(error) })
  }
}

snapshot.incidents = snapshot.incidents
  .filter((incident) => incident.keyword_match)
  .sort((a, b) => new Date(b.created_at ?? b.started_at ?? 0) - new Date(a.created_at ?? a.started_at ?? 0))
  .slice(0, 50)

await writeFile('public/data/status-snapshot.json', `${JSON.stringify(snapshot, null, 2)}\n`)
console.log(`Wrote ${snapshot.incidents.length} matched incidents to public/data/status-snapshot.json`)
await pushSnapshot('status', snapshot)

const autoResetFeed = {
  generated_at: snapshot.generated_at,
  resets: autoResets
    .sort((a, b) => new Date(b.announced_at ?? 0) - new Date(a.announced_at ?? 0))
    .slice(0, 25),
}
await writeFile('public/data/auto-resets.json', `${JSON.stringify(autoResetFeed, null, 2)}\n`)
console.log(`Wrote ${autoResetFeed.resets.length} auto-detected reset signals to public/data/auto-resets.json`)
await pushSnapshot('auto-resets', autoResetFeed)

if (snapshot.errors.length) {
  console.warn('Fetch errors:', snapshot.errors)
}
