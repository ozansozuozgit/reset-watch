import { describe, expect, it, vi } from 'vitest'
import { loadSnapshot } from './live'

describe('loadSnapshot fallback', () => {
  it('returns the Supabase result and never touches the file when Supabase has data', async () => {
    const fromFile = vi.fn(async () => ({ source: 'file' }))
    const result = await loadSnapshot(async () => ({ source: 'supabase' }), fromFile)
    expect(result).toEqual({ source: 'supabase' })
    expect(fromFile).not.toHaveBeenCalled()
  })

  it('falls back to the static file when Supabase returns null', async () => {
    const result = await loadSnapshot(async () => null, async () => ({ source: 'file' }))
    expect(result).toEqual({ source: 'file' })
  })

  it('returns null when neither source has data', async () => {
    const result = await loadSnapshot<{ source: string }>(async () => null, async () => null)
    expect(result).toBeNull()
  })
})
