import 'server-only'
import { getDb } from './db'
import { getConfig } from './config'
import { listNetworkPolicies } from './k8s'
import { getDiscoveredFlows, flushFlowWrites } from './hubble'
import { summarizeImpact, type TrafficImpact } from './impactSummary'
import type { Draft } from '@/types'

// What a change about to be applied directly (outside Modo Rascunho) would
// block, judged against the traffic Descoberta has seen: the same
// simulateImpact() the Rascunhos tab's warning uses, run server-side so the
// browser doesn't need the whole flow list for one click. `drafts` describe
// the change exactly like Modo Rascunho would stage it.
export async function computeTrafficImpact(drafts: Draft[]): Promise<TrafficImpact> {
  const enabled = getConfig().hubble_discovery_enabled
  flushFlowWrites() // include the last second of traffic
  const [flows, policies] = await Promise.all([Promise.resolve(getDiscoveredFlows()), listNetworkPolicies(true)])
  const lastCleared = (getDb().prepare(
    "SELECT created_at FROM audit_logs WHERE action = 'clear_discovered_flows' ORDER BY created_at DESC LIMIT 1",
  ).get() as { created_at: string } | undefined)?.created_at ?? null
  return summarizeImpact({ enabled, flows, policies, drafts, lastCleared })
}
