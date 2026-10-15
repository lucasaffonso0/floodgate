import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('server-only', () => ({}))
const { addWriter, removeWriter, emit } = await import('./sse')

describe('emit', () => {
  let received: string[]
  const writer = (chunk: string) => { received.push(chunk) }
  beforeEach(() => { vi.useFakeTimers(); received = []; addWriter(writer) })
  afterEach(() => { removeWriter(writer); vi.useRealTimers() })

  const types = () => received.map(c => JSON.parse(c.replace(/^data: /, '')).type)

  it('collapses identical change events inside the window into one', () => {
    emit({ type: 'policy_created' })
    emit({ type: 'policy_created' })
    emit({ type: 'policy_created' })
    expect(received).toEqual([])
    vi.advanceTimersByTime(500)
    expect(types()).toEqual(['policy_created'])
  })

  it('still delivers every distinct event, in order', () => {
    emit({ type: 'policy_deleted' })
    emit({ type: 'policy_created' })
    emit({ type: 'approval_applied', id: 'a' })
    emit({ type: 'approval_applied', id: 'b' })
    vi.advanceTimersByTime(500)
    expect(types()).toEqual(['policy_deleted', 'policy_created', 'approval_applied', 'approval_applied'])
  })

  it('sends approval_created immediately', () => {
    emit({ type: 'approval_created', id: 'x', created_by: 'u1', allowed_approver_ids: [] })
    expect(types()).toEqual(['approval_created'])
  })
})
