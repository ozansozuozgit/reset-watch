import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { scoreText, summarizeTopic } from './lib/social-score.mjs'

const topics = [
  {
    id: 'openai-codex',
    company: 'openai',
    product: 'Codex',
    queries: ['Codex slow', 'Codex degraded', 'Codex unusable', 'Codex usage limits', 'Codex reset limits'],
    // Official accounts that announce Codex limit/quota changes directly.
    official_handles: ['thsottiaux'],
  },
  {
    id: 'anthropic-claude-code',
    company: 'anthropic',
    product: 'Claude Code',
    queries: ['Claude Code slow', 'Claude Code degraded', 'Claude Code unusable', 'Claude Code usage limits', 'Claude Code reset limits'],
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
  for (const query of topic.queries.slice(0, 3)) {
    const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}&tags=story,comment&hitsPerPage=20`
    const data = await fetchJson(url)
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
  for (const query of topic.queries.slice(0, 3)) {
    const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&t=week&limit=20`
    const data = await fetchJson(url)
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
  for (const query of topic.queries.slice(0, 3)) {
    const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(query)}&limit=20&sort=latest`
    const data = await fetchJson(url)
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
    const html = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { accept: 'text/html' })
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
    const html = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { accept: 'text/html' })
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

for (const topic of topics) {
  const rawItems = []
  const fetchers = [
    hnSearch,
    (targetTopic) => duckDuckGoSiteSearch(targetTopic, 'x.com', 'x-search-snippet'),
    (targetTopic) => duckDuckGoSiteSearch(targetTopic, 'reddit.com', 'reddit-search-snippet'),
    (targetTopic) => duckDuckGoSiteSearch(targetTopic, 'bsky.app', 'bluesky-search-snippet'),
    (targetTopic) => officialProfileSearch(targetTopic),
  ]
  for (const fetcher of fetchers) {
    try {
      rawItems.push(...await fetcher(topic))
    } catch (error) {
      snapshot.errors.push({ topic: topic.id, source: fetcher.name, message: error instanceof Error ? error.message : String(error) })
    }
  }
  snapshot.topics.push(summarizeTopic(topic, rawItems, overrides))
}

await writeFile('public/data/social-snapshot.json', `${JSON.stringify(snapshot, null, 2)}\n`)
console.log(`Wrote ${snapshot.topics.length} social topics to public/data/social-snapshot.json`)
if (snapshot.errors.length) console.warn('Social fetch errors:', snapshot.errors)
