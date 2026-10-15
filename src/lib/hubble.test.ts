import { describe, it, expect } from 'vitest'
import { vi } from 'vitest'
import type { NetworkPolicyInfo } from '@/types'

vi.mock('server-only', () => ({}))
// Real in-memory SQLite (not a stub) so updateFlowPolicies' reclassification
// can be observed on actual rows.
vi.mock('./db', async () => {
  const { default: Database } = await import('better-sqlite3')
  const db = new Database(':memory:')
  for (const table of ['discovered_flows', 'ignored_flows']) {
    db.exec(`CREATE TABLE ${table} (
      id TEXT PRIMARY KEY, src_workload TEXT NOT NULL, src_namespace TEXT NOT NULL,
      dst_workload TEXT NOT NULL, dst_namespace TEXT NOT NULL, dst_port INTEGER NOT NULL,
      protocol TEXT NOT NULL, verdict TEXT NOT NULL, flow_count INTEGER NOT NULL DEFAULT 1,
      has_policy INTEGER NOT NULL DEFAULT 0, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL)`)
  }
  return { getDb: () => db }
})
vi.mock('./k8s', () => ({ listNetworkPolicies: vi.fn(), checkHubbleRelayReady: vi.fn(), listServices: vi.fn() }))
vi.mock('./config', () => ({ getConfig: () => ({ ignored_namespaces: [], hubble_flow_retention_days: 7, hubble_internet_flow_retention_days: 1 }) }))
vi.mock('./sse', () => ({ emit: vi.fn() }))

const { __testing, updateFlowPolicies } = await import('./hubble')
const { policyFingerprint, excludeUnappliedGitOps } = __testing
const { getDb } = await import('./db')
const { listNetworkPolicies } = await import('./k8s')

function policy(overrides: Partial<NetworkPolicyInfo> = {}): NetworkPolicyInfo {
  return {
    name: 'floodgate-allow-x', namespace: 'backend',
    src_workload: 'app', src_namespace: 'frontend', dst_service: 'worker', dst_port: 8080, dst_ports: [{ port: 8080, protocol: 'TCP' }],
    policy_type: 'allow', managed: true, policy_types: ['Ingress'], pod_selector: {}, ingress_count: 1, egress_count: 0,
    ...overrides,
  }
}

describe('excludeUnappliedGitOps', () => {
  // The actual bug: has_policy (drives the "Criar política" button and the
  // "Sem política" counter) must reflect whether Cilium is enforcing a
  // covering policy RIGHT NOW, not whether floodgate has committed one to
  // git. A synthesized pending_argocd entry (not yet applied) used to
  // count as "covered" just like a real one.
  it('excludes a policy with sync_status "pending_argocd"', () => {
    const result = excludeUnappliedGitOps([policy({ sync_status: 'pending_argocd' })])
    expect(result).toEqual([])
  })

  it('keeps a policy with sync_status "applied"', () => {
    const p = policy({ sync_status: 'applied' })
    expect(excludeUnappliedGitOps([p])).toEqual([p])
  })

  it('keeps a policy with sync_status "pending_delete": still live, just waiting on ArgoCD to prune', () => {
    const p = policy({ sync_status: 'pending_delete' })
    expect(excludeUnappliedGitOps([p])).toEqual([p])
  })

  it('keeps a policy with no sync_status at all (direct mode, where this distinction does not apply)', () => {
    const p = policy()
    expect(excludeUnappliedGitOps([p])).toEqual([p])
  })
})

describe('policyFingerprint', () => {
  it('changes when a policy transitions from pending_argocd to applied, even though every other field is identical', () => {
    const pending = policyFingerprint([policy({ sync_status: 'pending_argocd' })])
    const applied = policyFingerprint([policy({ sync_status: 'applied' })])
    // This is what makes updateFlowPolicies() (hubble.ts) actually
    // reclassify flows once ArgoCD catches up; without sync_status in the
    // fingerprint, this transition would look like "nothing changed" and
    // the skip-reclassification optimization would leave has_policy stale.
    expect(pending).not.toBe(applied)
  })

  it('is stable (order-independent) for the same set of policies', () => {
    const a = policyFingerprint([policy({ name: 'x' }), policy({ name: 'y' })])
    const b = policyFingerprint([policy({ name: 'y' }), policy({ name: 'x' })])
    expect(a).toBe(b)
  })

  it('changes when a policy is added or removed', () => {
    const one = policyFingerprint([policy({ name: 'x' })])
    const two = policyFingerprint([policy({ name: 'x' }), policy({ name: 'y' })])
    expect(one).not.toBe(two)
  })
})

describe('updateFlowPolicies', () => {
  const hasPolicy = () =>
    (getDb().prepare("SELECT has_policy FROM discovered_flows WHERE id = 'f1'").get() as { has_policy: number }).has_policy

  it('reclassifies even when no policy is left, clearing a stale has_policy', async () => {
    getDb().prepare(`INSERT INTO discovered_flows VALUES ('f1','app','frontend','worker','backend',8080,'TCP','FORWARDED',1,1,'2026-01-01','2026-01-01')`).run()

    // A failing K8s read must not be mistaken for "zero policies": the
    // classification stays as it was until a real answer comes back.
    vi.mocked(listNetworkPolicies).mockRejectedValueOnce(new Error('apiserver unavailable'))
    await updateFlowPolicies()
    expect(hasPolicy()).toBe(1)

    // The last policy was deleted (or everything got paused): the flow is
    // no longer covered and must say so. This used to return early on an
    // empty list and leave has_policy=1 forever.
    vi.mocked(listNetworkPolicies).mockResolvedValueOnce([])
    await updateFlowPolicies()
    expect(hasPolicy()).toBe(0)
  })
})

describe('getDiscoveredFlowsSummary', () => {
  const db = () => getDb()
  const insert = (id: string, verdict: string, hasPolicy: number, lastSeen: string) =>
    db().prepare(`INSERT INTO discovered_flows VALUES (?, 'app','frontend','worker','backend',8080,'TCP',?,1,?,'2026-01-01',?)`).run(id, verdict, hasPolicy, lastSeen)

  it('counts flows and unprotected drops, and its version moves only when the data does', async () => {
    const { getDiscoveredFlowsSummary } = await import('./hubble')
    db().prepare('DELETE FROM discovered_flows').run()
    insert('a', 'DROPPED', 0, '2026-01-01T00:00:00Z')
    insert('b', 'DROPPED', 1, '2026-01-01T00:00:00Z')
    insert('c', 'FORWARDED', 0, '2026-01-01T00:00:00Z')

    const s1 = getDiscoveredFlowsSummary()
    expect(s1.total).toBe(3)
    expect(s1.unprotected_dropped).toBe(1)
    expect(getDiscoveredFlowsSummary().version).toBe(s1.version) // nothing changed

    db().prepare("UPDATE discovered_flows SET last_seen = '2026-01-02T00:00:00Z' WHERE id = 'c'").run()
    const s2 = getDiscoveredFlowsSummary()
    expect(s2.version).not.toBe(s1.version) // traffic seen again

    db().prepare("UPDATE discovered_flows SET has_policy = 1 WHERE id = 'a'").run()
    const s3 = getDiscoveredFlowsSummary()
    expect(s3.version).not.toBe(s2.version) // reclassified
    expect(s3.unprotected_dropped).toBe(0)

    db().prepare("DELETE FROM discovered_flows WHERE id = 'b'").run()
    expect(getDiscoveredFlowsSummary().version).not.toBe(s3.version) // retention/clear
  })
})
