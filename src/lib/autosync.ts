import 'server-only'
import { getDb } from './db'
import { listNetworkPolicies, applyPolicyYAML, getPolicyYAML } from './k8s'

export function saveManagedPolicy(namespace: string, name: string, policyYaml: string): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO managed_policies (namespace, name, policy_yaml, saved_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(namespace, name, policyYaml)
}

export function removeManagedPolicy(namespace: string, name: string): void {
  getDb().prepare('DELETE FROM managed_policies WHERE namespace = ? AND name = ?').run(namespace, name)
}

export function getManagedPolicyCount(): number {
  return (getDb().prepare('SELECT COUNT(*) as n FROM managed_policies').get() as { n: number }).n
}

// ── Drift check (read-only, always runs) ────────────────────────────────────

export interface DriftEntry {
  namespace: string
  name: string
  policy_yaml?: string
}

export interface DriftResult {
  missing: DriftEntry[]
  timestamp: string
}

const g = global as typeof global & {
  _floodgateDriftResult?: DriftResult
  _floodgateSyncResult?: SyncResult
}

export function getLastDriftResult(): DriftResult | null {
  return g._floodgateDriftResult ?? null
}

export async function checkDrift(): Promise<DriftResult> {
  const db = getDb()

  // Skip if paused — intentionally empty
  const paused = (db.prepare('SELECT COUNT(*) as n FROM saved_policies').get() as { n: number }).n > 0
  if (paused) {
    const r: DriftResult = { missing: [], timestamp: new Date().toISOString() }
    g._floodgateDriftResult = r
    return r
  }

  const desired = db.prepare('SELECT namespace, name, policy_yaml FROM managed_policies').all() as Array<{ namespace: string; name: string; policy_yaml: string }>
  if (desired.length === 0) {
    const r: DriftResult = { missing: [], timestamp: new Date().toISOString() }
    g._floodgateDriftResult = r
    return r
  }

  const active = await listNetworkPolicies(false)
  const activeSet = new Set(active.map(p => `${p.namespace}/${p.name}`))
  const missing: DriftEntry[] = desired
    .filter(r => !activeSet.has(`${r.namespace}/${r.name}`))
    .map(r => ({ namespace: r.namespace, name: r.name, policy_yaml: r.policy_yaml }))

  const result: DriftResult = { missing, timestamp: new Date().toISOString() }
  g._floodgateDriftResult = result
  return result
}

// ── Sync (detects + fixes, only called when enabled or forced) ───────────────

export interface SyncResult {
  checked: number
  fixed: number
  seeded: number
  drifted: DriftEntry[]
  timestamp: string
}

export function getLastSyncResult(): SyncResult | null {
  return g._floodgateSyncResult ?? null
}

export async function runAutosync(): Promise<SyncResult> {
  const db = getDb()

  // Skip if paused
  const paused = (db.prepare('SELECT COUNT(*) as n FROM saved_policies').get() as { n: number }).n > 0
  if (paused) {
    const r: SyncResult = { checked: 0, fixed: 0, seeded: 0, drifted: [], timestamp: new Date().toISOString() }
    g._floodgateSyncResult = r
    return r
  }

  const active = await listNetworkPolicies(false)

  // First run: seed managed_policies from K8s
  const desiredCount = getManagedPolicyCount()
  if (desiredCount === 0 && active.length > 0) {
    for (const p of active) {
      try {
        const y = await getPolicyYAML(p.namespace, p.name)
        saveManagedPolicy(p.namespace, p.name, y)
      } catch { /* skip */ }
    }
    const seeded = getManagedPolicyCount()
    const r: SyncResult = { checked: seeded, fixed: 0, seeded, drifted: [], timestamp: new Date().toISOString() }
    g._floodgateSyncResult = r
    // Update drift cache too
    g._floodgateDriftResult = { missing: [], timestamp: r.timestamp }
    return r
  }

  const desired = db.prepare('SELECT namespace, name, policy_yaml FROM managed_policies').all() as Array<{
    namespace: string; name: string; policy_yaml: string
  }>

  const activeSet = new Set(active.map(p => `${p.namespace}/${p.name}`))
  const drifted: DriftEntry[] = []

  for (const row of desired) {
    if (!activeSet.has(`${row.namespace}/${row.name}`)) {
      try {
        await applyPolicyYAML(row.namespace, row.policy_yaml)
        drifted.push({ namespace: row.namespace, name: row.name })
      } catch (e) {
        console.error(`[autosync] Failed to restore ${row.namespace}/${row.name}:`, e)
      }
    }
  }

  const r: SyncResult = {
    checked: desired.length, fixed: drifted.length, seeded: 0, drifted,
    timestamp: new Date().toISOString(),
  }
  g._floodgateSyncResult = r
  g._floodgateDriftResult = { missing: [], timestamp: r.timestamp }
  return r
}
