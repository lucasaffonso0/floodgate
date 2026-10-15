import type { CiliumFlowSummary } from '@/types'

// One graph edge's worth of flow rows: the most recent row (what the edge's
// "Por quê?" panel and "Abrir na Descoberta" use) plus every destination
// port seen on the pair.
export type FlowEdge = CiliumFlowSummary & { dst_ports: number[] }

// Collapses the flow list to what the graph draws: one entry per source,
// destination and verdict. Internet destinations collapse per source (the
// graph draws every external IP into the single Internet box anyway), which
// is where most rows come from. Lossless for the graph:
// - order: each entry sits where its pair first appears in `flows`, so
//   edges keep the positions (and curvatures) the full list gave them;
// - representative: the latest row by last_seen, same rule the graph
//   applies itself when several rows land on one edge;
// - flow_count: summed over the collapsed rows.
export function aggregateFlowEdges(flows: CiliumFlowSummary[]): FlowEdge[] {
  const byKey = new Map<string, { edge: FlowEdge; ports: Set<number> }>()
  for (const f of flows) {
    const dst = f.dst_namespace === 'internet' ? '' : f.dst_workload
    const key = `${f.src_namespace}|${f.src_workload}|${f.dst_namespace}|${dst}|${f.verdict}`
    const entry = byKey.get(key)
    if (!entry) {
      byKey.set(key, { edge: { ...f, dst_ports: [] }, ports: new Set([f.dst_port]) })
      continue
    }
    entry.ports.add(f.dst_port)
    const flowCount = entry.edge.flow_count + f.flow_count
    if (f.last_seen > entry.edge.last_seen) entry.edge = { ...f, dst_ports: [] }
    entry.edge.flow_count = flowCount
  }
  return [...byKey.values()].map(({ edge, ports }) => ({ ...edge, dst_ports: [...ports].sort((a, b) => a - b) }))
}
