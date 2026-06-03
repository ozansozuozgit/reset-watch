import { mkdir, readFile, writeFile } from 'node:fs/promises'

const topics = [
  {
    id: 'openai-codex',
    company: 'openai',
    product: 'Codex',
    queries: ['Codex slow', 'Codex degraded', 'Codex unusable', 'Codex usage limits', 'Codex reset limits'],
  },
  {
    id: 'anthropic-claude-code',
    company: 'anthropic',
    product: 'Claude Code',
    queries: ['Claude Code slow', 'Claude Code degraded', 'Claude Code unusable', 'Claude Code usage limits', 'Claude Code reset limits'],
  },
]

const painTerms = [
  'degraded', 'degradation', 'slow', 'slower', 'unusable', 'broken', 'worse', 'regression', 'bug', 'bugs',
  'error', 'errors', 'failed', 'failure', 'outage', 'latency', 'stuck', 'down', 'drain', 'drained', 'limits',
  'limit', 'quota', 'rate limit', 'compaction', 'burned', 'burnt', 'wasted', 'nerfed', 'cooked',
]
const resetTerms = ['reset', 'resets', 'restored', 'restore', 'refund', 'refunded', 'compensate', 'compensation', 'make-good', 'apology', 'weekly', 'hourly']
const positiveTerms = ['fixed', 'resolved', 'shipped', 'better', 'improved', 'working']

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

function termMatches(text, terms) {
  const lower = text.toLowerCase()
  return terms.filter((term) => lower.includes(term))
}

function scoreText(text) {
  const pain = termMatches(text, painTerms)
  const reset = termMatches(text, resetTerms)
  const positive = termMatches(text, positiveTerms)
  return {
    pain,
    reset,
    positive,
    score: pain.length * 8 + reset.length * 5 - positive.length * 3,
  }
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

function dedupe(items) {
  const seen = new Set()
  return items.filter((item) => {
    const key = `${item.source}:${item.url || item.title}`.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
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

async function loadOverrides() {
  try {
    return JSON.parse(await readFile('public/data/social-overrides.json', 'utf8'))
  } catch {
    return { generated_at: new Date(0).toISOString(), topics: [] }
  }
}

function applyOverride(summary, overrides) {
  const override = overrides.topics?.find((item) => item.id === summary.id || item.product === summary.product)
  if (!override) return summary
  const heat = Math.max(summary.heat, Math.min(100, (summary.heat ?? 0) + (override.heat_boost ?? 0)))
  return {
    ...summary,
    heat,
    reset_chatter: Math.min(100, summary.reset_chatter + (override.reset_chatter_boost ?? 0)),
    pain_chatter: Math.min(100, summary.pain_chatter + (override.pain_chatter_boost ?? 0)),
    notes: [...summary.notes, `Manual override: ${override.note || 'operator marked elevated community signal'}`],
  }
}

function summarizeTopic(topic, rawItems, overrides) {
  const items = dedupe(rawItems)
    .filter((item) => item.score > 0 || item.matched_terms.length)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 40)

  const volume = items.length
  const painHits = items.reduce((sum, item) => sum + termMatches(`${item.title} ${(item.matched_terms ?? []).join(' ')}`, painTerms).length, 0)
  const resetHits = items.reduce((sum, item) => sum + termMatches(`${item.title} ${(item.matched_terms ?? []).join(' ')}`, resetTerms).length, 0)
  const sourceCounts = items.reduce((acc, item) => ({ ...acc, [item.source]: (acc[item.source] ?? 0) + 1 }), {})
  const topTerms = [...new Set(items.flatMap((item) => item.matched_terms ?? []))].slice(0, 10)
  const heat = Math.min(100, Math.round(volume * 5 + painHits * 5 + resetHits * 2))
  const painChatter = Math.min(100, Math.round(painHits * 8 + volume * 3))
  const resetChatter = Math.min(100, Math.round(resetHits * 10 + volume * 1.5))
  const sentiment = volume ? Math.max(-0.95, Math.min(0.25, Math.round((resetHits * 0.03 - painHits * 0.08) * 100) / 100)) : 0

  return applyOverride({
    id: topic.id,
    company: topic.company,
    product: topic.product,
    heat,
    sentiment,
    volume,
    pain_chatter: painChatter,
    reset_chatter: resetChatter,
    top_terms: topTerms,
    sources: sourceCounts,
    examples: items.slice(0, 6).map(({ source, title, url, published_at, matched_terms }) => ({ source, title, url, published_at, matched_terms })),
    notes: [
      'Free-only community signal: HN Algolia plus DuckDuckGo snippets for X, Reddit, and Bluesky when available.',
      'Counts are noisy and rate-limit tolerant; use heat as a directional vibe check, not analytics-grade sentiment.',
    ],
  }, overrides)
}

await mkdir('public/data', { recursive: true })

const snapshot = {
  generated_at: new Date().toISOString(),
  sources: [
    { name: 'hn', url: 'https://hn.algolia.com/api' },
    { name: 'x-search-snippet', url: 'https://html.duckduckgo.com/html/?q=site:x.com' },
    { name: 'reddit-search-snippet', url: 'https://html.duckduckgo.com/html/?q=site:reddit.com' },
    { name: 'bluesky-search-snippet', url: 'https://html.duckduckgo.com/html/?q=site:bsky.app' },
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
