import { describe, expect, it } from 'vitest'
import {
  // @ts-expect-error - plain ESM helper module, no type declarations
  tavilySearchRequest, normalizeTavilyResults, withinBudget, monthKey,
} from './tavily.mjs'

describe('tavilySearchRequest', () => {
  it('builds a basic POST search scoped to the given domains (filters are free)', () => {
    const req = tavilySearchRequest('Claude Code down', {
      apiKey: 'tvly-dev-xyz',
      includeDomains: ['reddit.com', 'x.com'],
      maxResults: 20,
    })
    expect(req.url).toBe('https://api.tavily.com/search')
    expect(req.method).toBe('POST')
    expect(req.headers.Authorization).toBe('Bearer tvly-dev-xyz')
    expect(req.headers['Content-Type']).toBe('application/json')
    const body = JSON.parse(req.body)
    expect(body.query).toBe('Claude Code down')
    expect(body.search_depth).toBe('basic') // 1 credit, not 2
    expect(body.include_domains).toEqual(['reddit.com', 'x.com'])
    expect(body.max_results).toBe(20)
  })
})

describe('normalizeTavilyResults', () => {
  it('maps title+content into scoreable posts and keeps published dates', () => {
    const json = {
      results: [
        { title: 'Claude Code is down', content: 'getting 500s', url: 'https://reddit.com/r/x/1', published_date: '2026-06-05T10:00:00Z' },
        { title: '', content: '', url: 'https://x.com/y' },
      ],
    }
    const items = normalizeTavilyResults(json)
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe('Claude Code is down')
    expect(items[0].text).toContain('getting 500s')
    expect(items[0].url).toBe('https://reddit.com/r/x/1')
    expect(items[0].published_at).toBe('2026-06-05T10:00:00Z')
  })

  it('returns [] for malformed input', () => {
    expect(normalizeTavilyResults(null)).toEqual([])
    expect(normalizeTavilyResults({})).toEqual([])
  })
})

describe('withinBudget', () => {
  it('allows a call only while used + spent + cost stays at or under the cap', () => {
    expect(withinBudget(0, 0, 1, 700)).toBe(true)
    expect(withinBudget(699, 0, 1, 700)).toBe(true)
    expect(withinBudget(700, 0, 1, 700)).toBe(false)
    expect(withinBudget(698, 1, 1, 700)).toBe(true)
    expect(withinBudget(698, 2, 1, 700)).toBe(false)
  })
})

describe('monthKey', () => {
  it('formats a date as YYYY-MM (UTC)', () => {
    expect(monthKey(new Date('2026-06-05T23:30:00Z'))).toBe('2026-06')
    expect(monthKey(new Date('2026-12-31T12:00:00Z'))).toBe('2026-12')
  })
})
