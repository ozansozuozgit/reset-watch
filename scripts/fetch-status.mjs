import { mkdir, writeFile } from 'node:fs/promises'

const sources = [
  ['openai', 'https://status.openai.com/api/v2/incidents.json'],
  ['anthropic', 'https://status.claude.com/api/v2/incidents.json'],
]

const keywords = /codex|claude code|rate limit|usage limit|quota|meter|compaction|cache|consumed|reset/i

async function fetchJson(name, url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`${name} ${response.status} ${response.statusText}`)
  return response.json()
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

for (const [name, url] of sources) {
  try {
    const data = await fetchJson(name, url)
    snapshot.sources.push({ name, url, page: data.page?.name })
    snapshot.incidents.push(...(data.incidents ?? []).map((incident) => summarizeIncident(name, incident)))
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
if (snapshot.errors.length) {
  console.warn('Fetch errors:', snapshot.errors)
}
