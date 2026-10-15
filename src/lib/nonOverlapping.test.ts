import { describe, it, expect, vi } from 'vitest'
import { nonOverlapping } from './nonOverlapping'

describe('nonOverlapping', () => {
  it('skips a call while the previous run is still in flight, and reports the skip', async () => {
    let release!: () => void
    const fn = vi.fn(() => new Promise<void>(res => { release = res }))
    const onSkip = vi.fn()
    const job = nonOverlapping(fn, onSkip)

    const first = job()
    await job() // overlaps the first run: skipped, resolves immediately
    expect(fn).toHaveBeenCalledTimes(1)
    expect(onSkip).toHaveBeenCalledTimes(1)

    release()
    await first
    const third = job() // previous run finished: runs again
    expect(fn).toHaveBeenCalledTimes(2)
    release()
    await third
  })

  it('releases the guard when a run throws', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined)
    const job = nonOverlapping(fn)
    await expect(job()).rejects.toThrow('boom')
    await job()
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
