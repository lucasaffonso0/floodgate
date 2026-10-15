import type { CiliumFlowSummary } from '@/types'

// Same order the server returns (getDiscoveredFlows): first_seen descending,
// then id. Kept stable on purpose: the graph assigns edge curvature by
// position in this array.
function compareFlows(a: CiliumFlowSummary, b: CiliumFlowSummary): number {
  if (a.first_seen !== b.first_seen) return a.first_seen < b.first_seen ? 1 : -1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

// Applies a delta (rows changed since the version `current` was fetched at,
// plus the ids removed since) to the copy already held. Rows already present
// are replaced in place, so the usual case (traffic seen again on known
// connections) is one pass with no sort. Only when a delta brings rows not
// seen before is the result re-sorted.
export function mergeFlowsDelta(current: CiliumFlowSummary[], changed: CiliumFlowSummary[], removed: string[] = []): CiliumFlowSummary[] {
  if (changed.length === 0 && removed.length === 0) return current
  const byId = new Map(changed.map(f => [f.id, f]))
  const gone = new Set(removed)
  const merged: CiliumFlowSummary[] = []
  for (const f of current) {
    if (gone.has(f.id)) continue
    const next = byId.get(f.id)
    if (!next) { merged.push(f); continue }
    byId.delete(f.id)
    merged.push(next)
  }
  if (byId.size === 0) return merged
  return [...byId.values(), ...merged].sort(compareFlows)
}
