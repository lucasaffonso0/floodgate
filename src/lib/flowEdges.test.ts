import { describe, it, expect } from 'vitest'
import { aggregateFlowEdges } from './flowEdges'
import type { CiliumFlowSummary } from '@/types'

const flow = (id: string, o: Partial<CiliumFlowSummary>): CiliumFlowSummary => ({
  id, src_workload: 'app', src_namespace: 'web', dst_workload: 'api', dst_namespace: 'core', dst_port: 80, protocol: 'TCP',
  verdict: 'FORWARDED', flow_count: 1, has_policy: false, first_seen: '2026-01-01', last_seen: '2026-01-01', ...o,
})

describe('aggregateFlowEdges', () => {
  it('collapses rows of one pair and verdict, keeping the latest row, all ports and the summed count', () => {
    const edges = aggregateFlowEdges([
      flow('a', { dst_port: 80, last_seen: '2026-01-02', flow_count: 2 }),
      flow('b', { dst_port: 443, last_seen: '2026-01-05', flow_count: 3 }),
      flow('c', { dst_port: 80, verdict: 'DROPPED' }),
    ])
    expect(edges.map(e => [e.id, e.verdict, e.dst_ports, e.flow_count])).toEqual([
      ['b', 'FORWARDED', [80, 443], 5],
      ['c', 'DROPPED', [80], 1],
    ])
  })

  it('collapses internet destinations per source, not per IP', () => {
    const edges = aggregateFlowEdges([
      flow('a', { dst_namespace: 'internet', dst_workload: '1.1.1.1', dst_port: 443 }),
      flow('b', { dst_namespace: 'internet', dst_workload: '8.8.8.8', dst_port: 53 }),
      flow('c', { src_workload: 'other', dst_namespace: 'internet', dst_workload: '8.8.8.8' }),
    ])
    expect(edges.map(e => [e.src_workload, e.dst_ports])).toEqual([['app', [53, 443]], ['other', [80]]])
  })

  it('keeps each edge at the position its pair first appeared', () => {
    const edges = aggregateFlowEdges([
      flow('a', { dst_workload: 'x' }), flow('b', { dst_workload: 'y' }), flow('c', { dst_workload: 'x', last_seen: '2026-02-01' }),
    ])
    expect(edges.map(e => e.dst_workload)).toEqual(['x', 'y'])
  })
})
