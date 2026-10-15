import { describe, it, expect } from 'vitest'
import { mergeFlowsDelta } from './flowsDelta'
import type { CiliumFlowSummary } from '@/types'

const flow = (id: string, first_seen: string, extra: Partial<CiliumFlowSummary> = {}): CiliumFlowSummary => ({
  id, src_workload: 'a', src_namespace: 'n', dst_workload: 'b', dst_namespace: 'n', dst_port: 80, protocol: 'TCP',
  verdict: 'FORWARDED', flow_count: 1, has_policy: false, first_seen, last_seen: first_seen, ...extra,
})

describe('mergeFlowsDelta', () => {
  const current = [flow('c', '2026-01-03'), flow('b', '2026-01-02'), flow('a', '2026-01-01')]

  it('returns the same array when nothing changed', () => {
    expect(mergeFlowsDelta(current, [])).toBe(current)
  })

  it('replaces known rows in place without reordering', () => {
    const out = mergeFlowsDelta(current, [flow('b', '2026-01-02', { verdict: 'DROPPED', flow_count: 5 })])
    expect(out.map(f => f.id)).toEqual(['c', 'b', 'a'])
    expect(out[1]).toMatchObject({ verdict: 'DROPPED', flow_count: 5 })
    expect(out[0]).toBe(current[0])
  })

  it('drops removed rows', () => {
    const out = mergeFlowsDelta(current, [flow('a', '2026-01-01', { flow_count: 9 })], ['b'])
    expect(out.map(f => [f.id, f.flow_count])).toEqual([['c', 1], ['a', 9]])
  })

  it('adds new rows in the server order (first_seen desc, then id)', () => {
    const out = mergeFlowsDelta(current, [flow('z', '2026-01-04'), flow('m', '2026-01-02')])
    expect(out.map(f => f.id)).toEqual(['z', 'c', 'b', 'm', 'a'])
  })
})
