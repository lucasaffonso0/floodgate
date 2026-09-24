import 'server-only'
import { getDb } from './db'
import { listNetworkPolicies, applyPolicyYAML, getPolicyYAML, listNamespaceNames, sanitizeK8sName } from './k8s'
import { getWriteMode } from './writeMode'
import { listPolicyFiles, hasGitOpsCredentials } from './git'

// The target namespace itself (not just the policy) is gone: restoring will
// keep failing until someone recreates it. Kept apart from a transient error
// so callers can surface it distinctly instead of a generic "sync failed".
function isNamespaceGoneError(e: unknown): boolean {
  const err = e as { body?: unknown }
  try {
    const body = typeof err.body === 'string' ? JSON.parse(err.body) : err.body
    const b = body as { reason?: string; details?: { kind?: string } }
    return b?.reason === 'NotFound' && b?.details?.kind === 'namespaces'
  } catch {
    return false
  }
}

export function saveManagedPolicy(namespace: string, name: string, policyYaml: string): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO managed_policies (namespace, name, policy_yaml, saved_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(namespace, name, policyYaml)
}

export function removeManagedPolicy(namespace: string, name: string): void {
  getDb().prepare('DELETE FROM managed_policies WHERE namespace = ? AND name = ?').run(namespace, name)
}

// Registers the policies isolateNamespace() creates for one direction into
// managed_policies, reconstructing their deterministic names the same way
// isolateNamespace() builds them; used by both the manual "Isolar
// namespace" route and the auto-default-deny path so the two stay in sync.
export function trackIsolatedPolicies(namespace: string, direction: 'ingress' | 'egress', allowIntra: boolean, allowInternet: boolean): void {
  const names = [sanitizeK8sName(`floodgate-ns-deny-${direction}-${namespace}`)]
  if (allowIntra) names.push(sanitizeK8sName(`floodgate-intra-${direction}-${namespace}`))
  if (allowInternet && direction === 'egress') names.push(sanitizeK8sName(`floodgate-egress-internet-${namespace}`))
  for (const n of names) {
    getPolicyYAML(namespace, n).then(y => saveManagedPolicy(namespace, n, y)).catch(() => {})
  }
}

export function getManagedPolicyCount(): number {
  return (getDb().prepare('SELECT COUNT(*) as n FROM managed_policies').get() as { n: number }).n
}

// ── Drift check (read-only, always runs) ────────────────────────────────────

export interface DriftEntry {
  namespace: string
  name: string
  policy_yaml?: string
  namespace_missing?: boolean
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

// GitOps mode's drift signal: not "managed_policies vs K8s" (that would
// mean "my own write silently failed", which can't happen here, since floodgate
// never writes to K8s in this mode) but "repo git vs K8s": exactly the
// "has ArgoCD synced this yet" question the sync_status UI needs. Same
// DriftEntry[] shape, same 'missing' field, new meaning: pending sync,
// not a failure to recover from.
// policy_yaml is left undefined here (unlike the direct-mode path below);
// filling it in would mean one extra git.ts read per missing entry, and
// each read re-fetches the whole repo; not worth it for what's currently
// just a count/list, revisit if a "Ver YAML" affordance is added for these.
async function checkDriftViaGit(): Promise<DriftResult> {
  // Same "not configured yet" case mergeGitSyncStatus handles in
  // k8s-gitops.ts: GET /api/autosync is polled every 15s by the main
  // dashboard, so a repo that hasn't been connected in Config → GitOps
  // yet must read as "nothing to report" here, not 503 the whole poll.
  if (!hasGitOpsCredentials()) {
    const r: DriftResult = { missing: [], timestamp: new Date().toISOString() }
    g._floodgateDriftResult = r
    return r
  }
  let files: string[]
  try {
    files = await listPolicyFiles()
  } catch (e) {
    // Configured, but the repo is unreachable right now (network blip, bad
    // SSH auth, DNS failure, the git host down, ...), same reasoning as
    // the not-configured case above, just a different cause. This used to
    // reject the whole Promise.all below even though listNetworkPolicies/
    // listNamespaceNames don't touch git at all, which meant a transient
    // git failure broke drift reporting entirely instead of just going
    // stale until the repo is reachable again.
    console.error('[gitops] checkDriftViaGit: falha ao ler o repositório, reportando drift vazio:', e)
    const r: DriftResult = { missing: [], timestamp: new Date().toISOString() }
    g._floodgateDriftResult = r
    return r
  }
  const [active, namespaces] = await Promise.all([listNetworkPolicies(false), listNamespaceNames()])
  const activeSet = new Set(active.map(p => `${p.namespace}/${p.name}`))
  const missing: DriftEntry[] = []
  for (const filePath of files) {
    const match = filePath.match(/^(.+)\/([^/]+)\.yaml$/)
    if (!match) continue
    const [, namespace, name] = match
    if (!activeSet.has(`${namespace}/${name}`)) {
      missing.push({ namespace, name, namespace_missing: !namespaces.has(namespace) })
    }
  }
  const result: DriftResult = { missing, timestamp: new Date().toISOString() }
  g._floodgateDriftResult = result
  return result
}

export async function checkDrift(): Promise<DriftResult> {
  const db = getDb()

  // Skip if paused: intentionally empty
  const paused = (db.prepare('SELECT COUNT(*) as n FROM saved_policies').get() as { n: number }).n > 0
  if (paused) {
    const r: DriftResult = { missing: [], timestamp: new Date().toISOString() }
    g._floodgateDriftResult = r
    return r
  }

  if (getWriteMode() === 'gitops') return checkDriftViaGit()

  const desired = db.prepare('SELECT namespace, name, policy_yaml FROM managed_policies').all() as Array<{ namespace: string; name: string; policy_yaml: string }>
  if (desired.length === 0) {
    const r: DriftResult = { missing: [], timestamp: new Date().toISOString() }
    g._floodgateDriftResult = r
    return r
  }

  const [active, namespaces] = await Promise.all([listNetworkPolicies(false), listNamespaceNames()])
  const activeSet = new Set(active.map(p => `${p.namespace}/${p.name}`))
  const missing: DriftEntry[] = desired
    .filter(r => !activeSet.has(`${r.namespace}/${r.name}`))
    .map(r => ({
      namespace: r.namespace, name: r.name, policy_yaml: r.policy_yaml,
      namespace_missing: !namespaces.has(r.namespace),
    }))

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

// Logged once (not every scheduler tick) so it's clear the reapply loop is
// dormant on purpose under GitOps, not silently doing nothing.
let loggedGitopsAutosyncSkip = false

export async function runAutosync(): Promise<SyncResult> {
  const db = getDb()

  // Skip if paused
  const paused = (db.prepare('SELECT COUNT(*) as n FROM saved_policies').get() as { n: number }).n > 0
  if (paused) {
    const r: SyncResult = { checked: 0, fixed: 0, seeded: 0, drifted: [], timestamp: new Date().toISOString() }
    g._floodgateSyncResult = r
    return r
  }

  // ArgoCD's own selfHeal is the reapply mechanism under GitOps: running
  // floodgate's own reapply loop at the same time is a correctness risk
  // (it could reapply a version ArgoCD is mid-pruning). Only the read-only
  // detection half (checkDrift, above) still runs.
  if (getWriteMode() === 'gitops') {
    if (!loggedGitopsAutosyncSkip) {
      console.log('[autosync] WRITE_MODE=gitops: reapply disabled, ArgoCD selfHeal owns drift correction')
      loggedGitopsAutosyncSkip = true
    }
    const drift = await checkDrift()
    const r: SyncResult = { checked: 0, fixed: 0, seeded: 0, drifted: [], timestamp: drift.timestamp }
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

  const unrecoverable: DriftEntry[] = []

  for (const row of desired) {
    if (!activeSet.has(`${row.namespace}/${row.name}`)) {
      try {
        await applyPolicyYAML(row.namespace, row.policy_yaml)
        drifted.push({ namespace: row.namespace, name: row.name })
      } catch (e) {
        if (isNamespaceGoneError(e)) {
          // Namespace itself is gone: kept in managed_policies so it
          // auto-restores if the namespace comes back, but logged once as a
          // warning instead of an error dump repeated every cycle.
          console.warn(`[autosync] Namespace ${row.namespace} does not exist: ${row.name} stays tracked but cannot be restored`)
          unrecoverable.push({ namespace: row.namespace, name: row.name, namespace_missing: true })
        } else {
          console.error(`[autosync] Failed to restore ${row.namespace}/${row.name}:`, e)
        }
      }
    }
  }

  const r: SyncResult = {
    checked: desired.length, fixed: drifted.length, seeded: 0, drifted,
    timestamp: new Date().toISOString(),
  }
  g._floodgateSyncResult = r
  g._floodgateDriftResult = { missing: unrecoverable, timestamp: r.timestamp }
  return r
}
