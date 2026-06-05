import { afterEach, beforeEach, describe, expect, it } from 'vitest'
// @ts-expect-error - plain ESM helper module, no type declarations
import { pushSnapshot } from './push-snapshot.mjs'

const SAVED = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY }

describe('pushSnapshot without Supabase credentials', () => {
  beforeEach(() => {
    delete process.env.SUPABASE_URL
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
  })
  afterEach(() => {
    if (SAVED.url) process.env.SUPABASE_URL = SAVED.url
    if (SAVED.key) process.env.SUPABASE_SERVICE_ROLE_KEY = SAVED.key
  })

  it('skips (no throw, no network) when env vars are absent', async () => {
    const result = await pushSnapshot('social', { generated_at: 'now', topics: [] })
    expect(result.ok).toBe(false)
    expect(result.skipped).toBe(true)
  })
})
