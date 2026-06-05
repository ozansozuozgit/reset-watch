import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { scoreText, summarizeTopic } from './lib/social-score.mjs'
import { pushSnapshot } from './lib/push-snapshot.mjs'
import { withRetry, runWithFallback } from './lib/retry.mjs'
import { tavilySearchRequest, normalizeTavilyResults, withinBudget, monthKey, TAVILY_COST } from './lib/tavily.mjs'
import { readTavilyUsage, writeTavilyUsage } from './lib/tavily-budget.mjs'

const topics = [
  {
    id: 'openai-codex',
    company: 'openai',
    product: 'Codex',
    // Relevance gate: an item's title must mention one of these or it's dropped
    // (kills cross-topic bleed and "eBay/iPhone limits" search junk).
    relevance: ['codex'],
    // One Tavily query (semantic, free domain filtering). The free-fallback
    // scrapers use the keyword list below; precision comes from the score>0 filter.
    tavily_query: 'OpenAI Codex slow, down, broken, errors, degraded, rate limit, usage limits, outage',
    queries: ['Codex slow', 'Codex down', 'Codex degraded', 'Codex unusable', 'Codex errors', 'Codex usage limits', 'Codex rate limit', 'OpenAI Codex limits'],
    // Official accounts that announce Codex limit/quota changes directly.
    official_handles: ['thsottiaux'],
  },
  {
    id: 'anthropic-claude-code',
    company: 'anthropic',
    product: 'Claude Code',
    relevance: ['claude'],
    tavily_query: 'Claude Code (Anthropic) slow, down, broken, errors, degraded, rate limit, usage limits, outage',
    queries: ['Claude Code slow', 'Claude Code down', 'Claude Code degraded', 'Claude Code unusable', 'Claude Code errors', 'Claude Code usage limits', 'Claude Code rate limit', 'Anthropic limits'],
    official_handles: ['AlexAlbert_', 'AnthropicAI'],
  },
]

// Tavily config. One basic search per topic (1 credit). The monthly cap is the
// hard guarantee against overspend (the every-4h cron alone lands ~360/mo); when
// it's reached, or no key is set, the search degrades to the free scrapers.
const TAVILY_DOMAINS = ['reddit.com', 'x.com', 'twitter.com', 'bsky.app', 'news.ycombinator.com']
const TAVILY_API_KEY = process.env.TAVILY_API_KEY
// Robust against an unset CI variable (which arrives as ''): Number('') is 0,
// which would disable Tavily, so fall back to 700 unless a positive value is set.
const TAVILY_MONTHLY_CAP = Number(process.env.TAVILY_MONTHLY_CAP) > 0 ? Number(process.env.TAVILY_MONTHLY_CAP) : 700

const timeout = 9000

async function fetchText(url, headers = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json,text/html,text/plain,*/*',
        'user-agent': 'ResetWatch/1.0 free public-signal monitor',
        ...headers,
      },
    })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    return response.text()
  } finally {
    clearTimeout(timer)
  }
}

async function fetchJson(url, headers = {}) {
  return JSON.parse(await fetchText(url, headers))
}

// Retrying variants — public endpoints (Reddit/Bluesky/DDG) intermittently
// 429/5xx a shared CI runner IP; a couple of backed-off retries recover most of
// those without a source dropping to empty.
const fetchJsonR = (url, headers) => withRetry(() => fetchJson(url, headers), { attempts: 2, delayMs: 500 })
const fetchTextR = (url, headers) => withRetry(() => fetchText(url, headers), { attempts: 2, delayMs: 500 })

function stripHtml(value = '') {
  return value.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
}

function normalizeUrl(url = '') {
  try {
    const parsed = new URL(url)
    const uddg = parsed.searchParams.get('uddg')
    if (uddg) return decodeURIComponent(uddg)
    return parsed.href
  } catch {
    return url
  }
}

async function hnSearch(topic) {
  const items = []
  for (const query of topic.queries.slice(0, 4)) {
    const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}&tags=story,comment&hitsPerPage=20`
    const data = await fetchJsonR(url)
    for (const hit of data.hits ?? []) {
      const title = stripHtml(hit.title || hit.comment_text || hit.story_title || '')
      if (!title) continue
      const scored = scoreText(`${title} ${hit.url || ''}`)
      items.push({
        source: 'hn',
        title,
        url: hit.url || (hit.story_id ? `https://news.ycombinator.com/item?id=${hit.story_id}` : `https://news.ycombinator.com/item?id=${hit.objectID}`),
        published_at: hit.created_at,
        score: scored.score,
        matched_terms: [...new Set([...scored.pain, ...scored.reset])],
      })
    }
  }
  return items
}

// Primary social source: one budgeted Tavily search across the social web. Throws
// (so runWithFallback degrades to the free scrapers) when the key is missing or the
// monthly cap would be exceeded. Credits are only counted on a successful call.
async function tavilySearch(topic, budget) {
  if (!budget.key) throw new Error('TAVILY_API_KEY not set')
  if (!withinBudget(budget.used, budget.spent, TAVILY_COST, budget.cap)) {
    throw new Error(`monthly cap reached (${budget.used + budget.spent}/${budget.cap})`)
  }
  const req = tavilySearchRequest(topic.tavily_query, {
    apiKey: budget.key,
    includeDomains: TAVILY_DOMAINS,
    maxResults: 20,
    searchDepth: 'basic',
    days: 7,
  })
  const data = await withRetry(async () => {
    const response = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, signal: AbortSignal.timeout(timeout) })
    if (!response.ok) throw new Error(`Tavily ${response.status} ${response.statusText}`)
    return response.json()
  }, { attempts: 2, delayMs: 600 })
  budget.spent += TAVILY_COST
  return normalizeTavilyResults(data).map((post) => {
    const scored = scoreText(post.text)
    return {
      source: 'tavily',
      title: post.title,
      url: post.url,
      published_at: post.published_at,
      score: scored.score,
      matched_terms: [...new Set([...scored.pain, ...scored.reset])],
    }
  })
}

async function duckDuckGoSiteSearch(topic, site, source) {
  const items = []
  const queries = topic.queries.map((query) => `site:${site} ${query}`).slice(0, 4)
  for (const query of queries) {
    const html = await fetchTextR(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { accept: 'text/html' })
    const matches = [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/g)].slice(0, 8)
    for (const match of matches) {
      const title = stripHtml(match[2])
      const url = normalizeUrl(match[1])
      if (!title) continue
      const scored = scoreText(title)
      items.push({
        source,
        title,
        url,
        score: scored.score,
        matched_terms: [...new Set([...scored.pain, ...scored.reset])],
      })
    }
  }
  return items
}

// Free fallback bundle used when Tavily is unavailable or over budget: HN Algolia
// plus DuckDuckGo site snippets for X/Reddit/Bluesky. Best-effort — one source
// failing must not sink the rest — so each is wrapped individually.
async function freeSocialSearch(topic) {
  const items = []
  const sources = [
    hnSearch,
    (t) => duckDuckGoSiteSearch(t, 'x.com', 'x-search-snippet'),
    (t) => duckDuckGoSiteSearch(t, 'reddit.com', 'reddit-search-snippet'),
    (t) => duckDuckGoSiteSearch(t, 'bsky.app', 'bluesky-search-snippet'),
  ]
  for (const source of sources) {
    try {
      items.push(...await source(topic))
    } catch {
      // best-effort fallback; a blocked free source is expected from CI
    }
  }
  return items
}

// Issue #1: scan the timelines of official accounts that announce limit/quota
// resets directly, via the same free DuckDuckGo HTML fallback. Best-effort —
// DDG indexes X profiles sparsely — so it augments, never replaces, the keyword
// scrapers. Items are flagged `official` so summarizeTopic can give a verified
// reset mention a bounded, capped lift.
async function officialProfileSearch(topic, source = 'official-announcement') {
  if (!topic.official_handles?.length) return []
  const items = []
  for (const handle of topic.official_handles) {
    const query = `site:x.com/${handle} reset OR limits OR cleared OR fixed`
    const html = await fetchTextR(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { accept: 'text/html' })
    const matches = [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/g)].slice(0, 5)
    for (const match of matches) {
      const title = stripHtml(match[2])
      const url = normalizeUrl(match[1])
      if (!title) continue
      const scored = scoreText(title)
      items.push({
        source,
        official: true,
        title: `[OFFICIAL] ${title}`,
        url,
        // Modest score lift so official posts surface in the top examples; the
        // honest metric movement is the capped boost inside summarizeTopic.
        score: scored.score + 20,
        matched_terms: [...new Set([...scored.pain, ...scored.reset])],
      })
    }
  }
  return items
}

async function loadOverrides() {
  try {
    return JSON.parse(await readFile('public/data/social-overrides.json', 'utf8'))
  } catch {
    return { generated_at: new Date(0).toISOString(), topics: [] }
  }
}

await mkdir('public/data', { recursive: true })

const snapshot = {
  generated_at: new Date().toISOString(),
  sources: [
    { name: 'tavily', url: 'https://api.tavily.com/search' },
    { name: 'hn', url: 'https://hn.algolia.com/api' },
    { name: 'x-search-snippet', url: 'https://html.duckduckgo.com/html/?q=site:x.com' },
    { name: 'reddit-search-snippet', url: 'https://html.duckduckgo.com/html/?q=site:reddit.com' },
    { name: 'bluesky-search-snippet', url: 'https://html.duckduckgo.com/html/?q=site:bsky.app' },
    { name: 'official-announcement', url: 'https://html.duckduckgo.com/html/?q=site:x.com/<official-handle>' },
    { name: 'manual-overrides', url: '/data/social-overrides.json' },
  ],
  topics: [],
  errors: [],
}

const overrides = await loadOverrides()

const now = new Date(snapshot.generated_at)

// Monthly Tavily credit budget, read once and accumulated across topics this run,
// then persisted so the cap holds across runs (and manual workflow triggers).
const tavilyMonth = monthKey(now)
const budget = { key: TAVILY_API_KEY, cap: TAVILY_MONTHLY_CAP, used: await readTavilyUsage(tavilyMonth), spent: 0 }

for (const topic of topics) {
  const rawItems = []
  // Primary: one budgeted Tavily search across the social web. Degrades to the
  // free scrapers when the key is missing or the monthly cap is reached.
  const social = await runWithFallback(
    () => tavilySearch(topic, budget),
    () => freeSocialSearch(topic),
    (msg) => console.warn(`[social] tavily→free fallback for ${topic.id}: ${msg}`),
  )
  rawItems.push(...social)
  // Official-handle reset announcements (free, always run).
  try {
    rawItems.push(...await officialProfileSearch(topic))
  } catch (error) {
    snapshot.errors.push({ topic: topic.id, source: 'official-announcement', message: error instanceof Error ? error.message : String(error) })
  }
  snapshot.topics.push(summarizeTopic(topic, rawItems, overrides, now))
}

await writeFile('public/data/social-snapshot.json', `${JSON.stringify(snapshot, null, 2)}\n`)
console.log(`Wrote ${snapshot.topics.length} social topics to public/data/social-snapshot.json`)
await pushSnapshot('social', snapshot)

// Persist the month's Tavily spend (only when we actually spent).
if (budget.spent > 0) {
  await writeTavilyUsage(tavilyMonth, budget.used + budget.spent)
  console.log(`[tavily] spent ${budget.spent} credit(s) this run; month total ${budget.used + budget.spent}/${budget.cap}`)
}
if (snapshot.errors.length) console.warn('Social fetch errors:', snapshot.errors)
