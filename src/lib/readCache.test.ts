import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('server-only', () => ({}))
const { cachedRead, invalidateReads, readGeneration } = await import('./readCache')

describe('cachedRead', () => {
  beforeEach(() => { invalidateReads(); vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('serves repeated reads from cache within the TTL, then reloads', async () => {
    const load = vi.fn(async () => ['a'])
    await cachedRead('k', 5000, load)
    await cachedRead('k', 5000, load)
    expect(load).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(5001)
    await cachedRead('k', 5000, load)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('shares one in-flight read between concurrent callers', async () => {
    let resolve!: (v: string[]) => void
    const load = vi.fn(() => new Promise<string[]>(res => { resolve = res }))
    const a = cachedRead('k', 5000, load)
    const b = cachedRead('k', 5000, load)
    resolve(['x'])
    expect(await a).toEqual(['x'])
    expect(await b).toEqual(['x'])
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('reloads right after an invalidation (our own write must show up immediately)', async () => {
    const load = vi.fn().mockResolvedValueOnce(['before']).mockResolvedValueOnce(['after'])
    expect(await cachedRead('k', 5000, load)).toEqual(['before'])
    invalidateReads()
    expect(await cachedRead('k', 5000, load)).toEqual(['after'])
  })

  // The race the generation counter exists for: a list started BEFORE a
  // write finishes after it. Its result may not include the write, so it
  // must not be cached, and nobody arriving after the write may join it.
  it('never caches or shares a read that started before an invalidation', async () => {
    let resolveOld!: (v: string[]) => void
    const load = vi.fn()
      .mockImplementationOnce(() => new Promise<string[]>(res => { resolveOld = res }))
      .mockResolvedValueOnce(['fresh'])
      .mockResolvedValueOnce(['fresher'])
    const old = cachedRead('k', 5000, load)
    invalidateReads()
    expect(await cachedRead('k', 5000, load)).toEqual(['fresh']) // did not join the old read
    resolveOld(['stale'])
    expect(await old).toEqual(['stale']) // the old caller still gets its own answer
    expect(await cachedRead('k', 5000, load)).toEqual(['fresh']) // but 'stale' was not cached
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('hands out copies of cached arrays so in-place sorts do not leak between callers', async () => {
    const load = vi.fn(async () => [3, 1, 2])
    const first = await cachedRead('k', 5000, load)
    first.sort()
    expect(await cachedRead('k', 5000, load)).toEqual([3, 1, 2])
  })

  it('does not cache a failed read', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('apiserver down')).mockResolvedValueOnce(['ok'])
    await expect(cachedRead('k', 5000, load)).rejects.toThrow('apiserver down')
    expect(await cachedRead('k', 5000, load)).toEqual(['ok'])
  })

  it('bumps the generation on invalidation', () => {
    const before = readGeneration()
    invalidateReads()
    expect(readGeneration()).toBe(before + 1)
  })
})
