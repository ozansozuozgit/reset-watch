import { describe, expect, it, vi } from 'vitest'
// @ts-expect-error - plain ESM helper module, no type declarations
import { withRetry } from './retry.mjs'

describe('withRetry', () => {
  it('calls fn once and returns its result when the first attempt succeeds', async () => {
    const fn = vi.fn(async () => 'ok')
    const result = await withRetry(fn, { attempts: 3, delayMs: 0 })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries transient failures and returns once an attempt succeeds', async () => {
    let calls = 0
    const fn = vi.fn(async () => {
      calls += 1
      if (calls < 3) throw new Error('429 Too Many Requests')
      return 'ok'
    })
    const result = await withRetry(fn, { attempts: 3, delayMs: 0 })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('throws the last error after exhausting all attempts', async () => {
    const fn = vi.fn(async () => {
      throw new Error('405 Not Allowed')
    })
    await expect(withRetry(fn, { attempts: 3, delayMs: 0 })).rejects.toThrow('405 Not Allowed')
    expect(fn).toHaveBeenCalledTimes(3)
  })
})
