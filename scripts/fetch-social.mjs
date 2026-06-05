import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { scoreText, summarizeTopic } from './lib/social-score.mjs'
import { pushSnapshot } from './lib/push-snapshot.mjs'
import { withRetry, runWithFallback } from './lib/retry.mjs'

const topics = [
  {
    id: 'openai-codex',
    company: 'openai',
    product: 'Codex',
    // Broader symptom + brand queries; precision comes from the score>0 filter in
    // summarizeTopic, so we cast a wider net than rigid "<product> <symptom>" phrases.
    queries: ['Codex slow', 'Codex down', 'Codex degraded', 'Codex unusable', 'Codex errors', 'Codex usage limits', 'Codex rate limit', 'OpenAI Codex limits'],
    // Official accounts that announce Codex limit/quota changes directly.
    official_handles: ['thsottiaux'],
  },
  {
    id: 'anthropic-claude-code',
    company: 'anthropic',
    product: 'Claude Code',
    queries: ['Claude Code slow', 'Claude Code down', 'Claude Code degraded', 'Claude Code unusable', 'Claude Code errors', 'Claude Code usage limits', 'Claude Code rate limit', 'Anthropic limits'],
    official_handles: ['AlexAlbert_', 'AnthropicAI'],
  },
]

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

async function redditSearch(topic) {
  const items = []
  for (const query of topic.queries.slice(0, 4)) {
    const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&t=week&limit=20`
    const data = await fetchJsonR(url)
    for (const child of data.data?.children ?? []) {
      const post = child.data
      const title = stripHtml(`${post.title || ''} ${post.selftext || ''}`)
      if (!title.trim()) continue
      const scored = scoreText(title)
      items.push({
        source: 'reddit',
        title: stripHtml(post.title || title).slice(0, 240),
        url: post.permalink ? `https://www.reddit.com${post.permalink}` : `https://www.reddit.com/search/?q=${encodeURIComponent(query)}`,
        published_at: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : undefined,
        score: scored.score,
        matched_terms: [...new Set([...scored.pain, ...scored.reset])],
      })
    }
  }
  return items
}

async function blueskySearch(topic) {
  const items = []
  for (const query of topic.queries.slice(0, 6)) {
    const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(query)}&limit=20&sort=latest`
    const data = await fetchJsonR(url)
    for (const post of data.posts ?? []) {
      const text = stripHtml(post.record?.text || '')
      if (!text) continue
      const scored = scoreText(text)
      const handle = post.author?.handle
      const rkey = post.uri?.split('/').pop()
      items.push({
        source: 'bluesky',
        title: text.slice(0, 240),
        url: handle && rkey ? `https://bsky.app/profile/${handle}/post/${rkey}` : 'https://bsky.app/search',
        published_at: post.record?.createdAt,
        score: scored.score,
        matched_terms: [...new Set([...scored.pain, ...scored.reset])],
      })
    }
  }
  return items
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

for (const topic of topics) {
  const rawItems = []
  // Real free APIs (timestamped, higher recall) run first; the DuckDuckGo snippet
  // scrape is the won't-block fallback when a primary 403s/empties from CI.
  const fetchers = [
    { name: 'hn', run: hnSearch },
    { name: 'x-search-snippet', run: (t) => duckDuckGoSiteSearch(t, 'x.com', 'x-search-snippet') },
    { name: 'reddit', run: (t) => runWithFallback(() => redditSearch(t), () => duckDuckGoSiteSearch(t, 'reddit.com', 'reddit-search-snippet')) },
    { name: 'bluesky', run: (t) => runWithFallback(() => blueskySearch(t), () => duckDuckGoSiteSearch(t, 'bsky.app', 'bluesky-search-snippet')) },
    { name: 'official-announcement', run: officialProfileSearch },
  ]
  for (const fetcher of fetchers) {
    try {
      rawItems.push(...await fetcher.run(topic))
    } catch (error) {
      snapshot.errors.push({ topic: topic.id, source: fetcher.name, message: error instanceof Error ? error.message : String(error) })
    }
  }
  snapshot.topics.push(summarizeTopic(topic, rawItems, overrides, now))
}

await writeFile('public/data/social-snapshot.json', `${JSON.stringify(snapshot, null, 2)}\n`)
console.log(`Wrote ${snapshot.topics.length} social topics to public/data/social-snapshot.json`)
await pushSnapshot('social', snapshot)
if (snapshot.errors.length) console.warn('Social fetch errors:', snapshot.errors)
