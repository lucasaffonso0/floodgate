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
      has_policy INTEGER NOT NULL DEFAULT 0, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
      rev INTEGER NOT NULL DEFAULT 0)`)
  }
  db.exec('CREATE TABLE discovered_flows_deleted (id TEXT NOT NULL, rev INTEGER NOT NULL, deleted_at TEXT NOT NULL)')
  return { getDb: () => db }
})
vi.mock('./k8s', () => ({ listNetworkPolicies: vi.fn(), checkHubbleRelayReady: vi.fn(), listServices: vi.fn() }))
const testConfig = vi.hoisted(() => ({ ignored_namespaces: [] as string[], hubble_flow_retention_days: 7, hubble_internet_flow_retention_days: 1 }))
vi.mock('./config', () => ({ getConfig: () => testConfig }))
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
    getDb().prepare(`INSERT INTO discovered_flows VALUES ('f1','app','frontend','worker','backend',8080,'TCP','FORWARDED',1,1,'2026-01-01','2026-01-01',0)`).run()

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
  const insert = (id: string, verdict: string, hasPolicy: number, rev: number) =>
    db().prepare(`INSERT INTO discovered_flows VALUES (?, 'app','frontend','worker','backend',8080,'TCP',?,1,?,'2026-01-01','2026-01-01',?)`).run(id, verdict, hasPolicy, rev)

  it('counts flows and unprotected drops, and its version moves only when the data does', async () => {
    const { getDiscoveredFlowsSummary, clearDiscoveredFlows } = await import('./hubble')
    db().prepare('DELETE FROM discovered_flows').run()
    insert('a', 'DROPPED', 0, 1)
    insert('b', 'DROPPED', 1, 1)
    insert('c', 'FORWARDED', 0, 1)

    const s1 = getDiscoveredFlowsSummary()
    expect(s1.total).toBe(3)
    expect(s1.unprotected_dropped).toBe(1)
    expect(getDiscoveredFlowsSummary().version).toBe(s1.version) // nothing changed

    db().prepare("UPDATE discovered_flows SET has_policy = 1, rev = 2 WHERE id = 'a'").run()
    const s2 = getDiscoveredFlowsSummary()
    expect(s2.version).not.toBe(s1.version) // a write stamps a higher rev
    expect(s2.unprotected_dropped).toBe(0)

    clearDiscoveredFlows()
    expect(getDiscoveredFlowsSummary().version).not.toBe(s2.version) // deletes start a new generation
  })
})

describe('getDiscoveredFlowsSince', () => {
  const svc = (ns: string, name: string) => ({ namespace: ns, labels: [`k8s:app=${name}`], workloads: [{ name, kind: 'Deployment' }] })
  const msg = (srcPort: number, dst = 'worker', verdict = 'FORWARDED') => ({ flow: {
    verdict, source: svc('frontend', 'app'), destination: svc('backend', dst),
    ip: { source: '10.0.0.1', destination: '10.0.0.2' },
    l4: { TCP: { source_port: srcPort, destination_port: 8080 } },
  } })
  const ingest = async (...msgs: unknown[]) => {
    const mod = await import('./hubble')
    for (const m of msgs) mod.__testing.processFlow(m)
    mod.flushFlowWrites()
  }

  it('returns only rows written after the given version, and the full list when it cannot', async () => {
    const { getDiscoveredFlowsSince, clearDiscoveredFlows, invalidateIgnoredNamespacesCache } = await import('./hubble')
    testConfig.ignored_namespaces = []
    invalidateIgnoredNamespacesCache()
    clearDiscoveredFlows()
    await ingest(msg(50001, 'worker'), msg(50002, 'db'))

    const first = getDiscoveredFlowsSince(null)
    expect(first.full).toBe(true)
    expect(first.flows.map(f => f.dst_workload).sort()).toEqual(['db', 'worker'])

    expect(getDiscoveredFlowsSince(first.version)).toMatchObject({ full: false, flows: [], version: first.version })

    await ingest(msg(50003, 'worker', 'DROPPED'))
    const delta = getDiscoveredFlowsSince(first.version)
    expect(delta.full).toBe(false)
    expect(delta.flows.map(f => [f.dst_workload, f.verdict, f.flow_count])).toEqual([['worker', 'DROPPED', 2]])

    clearDiscoveredFlows()
    await ingest(msg(50004, 'cache'))
    const afterClear = getDiscoveredFlowsSince(delta.version)
    expect(afterClear.full).toBe(true) // a delete happened in between: rows must be replaced, not merged
    expect(afterClear.flows.map(f => f.dst_workload)).toEqual(['cache'])

    expect(getDiscoveredFlowsSince('garbage').full).toBe(true)
  })
})

describe('updateFlowPolicies: memoized reclassification matches the naive per-row result', () => {
  it('agrees with flowHasPolicy row by row on randomized flows and policies', async () => {
    const db = () => getDb()
    const { flowHasPolicy } = await import('./flowMatch')
    let state = 42
    // mulberry32: a deterministic PRNG with well-mixed low bits (a plain LCG
    // alternates its lowest bit and degenerates on small moduli like rnd(2)).
    const rnd = (n: number) => {
      state = (state + 0x6D2B79F5) | 0
      let t = Math.imul(state ^ (state >>> 15), 1 | state)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) % n
    }
    const nss = ['frontend', 'backend', 'data']
    const wls = ['app', 'worker', 'db', 'cache']
    const pick = <T,>(xs: T[]) => xs[rnd(xs.length)]

    db().prepare('DELETE FROM discovered_flows').run()
    const ins = db().prepare(`INSERT INTO discovered_flows VALUES (?,?,?,?,?,?,'TCP','DROPPED',1,?,'2026-01-01','2026-01-01',0)`)
    for (let i = 0; i < 400; i++) {
      const internet = rnd(3) === 0
      ins.run(`r${i}`, pick(wls), pick(nss),
        internet ? `203.0.113.${rnd(250)}` : pick(wls),
        internet ? 'internet' : pick(nss),
        internet ? 443 : pick([80, 8080, 5432]), rnd(2))
    }

    for (let round = 0; round < 5; round++) {
      const policies = Array.from({ length: 12 }, (_, j) => {
        const type = pick(['allow', 'allow-namespace', 'allow-egress', 'restrict-ingress', 'restrict-egress', 'allow-intranamespace'] as const)
        const ns = pick(nss)
        return policy({
          name: `p${round}-${j}`, namespace: ns, policy_type: type,
          src_workload: type === 'allow-namespace' ? '' : pick([...wls, '']),
          src_namespace: pick(nss),
          dst_service: type.startsWith('restrict') && rnd(2) ? '' : pick([...wls, 'internet']),
          dst_port: pick([80, 8080, 5432]), dst_ports: [{ port: pick([80, 8080, 5432]), protocol: 'TCP' as const }],
          policy_types: [rnd(2) ? 'Ingress' : 'Egress'],
        })
      })
      vi.mocked(listNetworkPolicies).mockResolvedValueOnce(policies)
      await updateFlowPolicies()
      const rows = db().prepare('SELECT * FROM discovered_flows').all() as Array<{ id: string; src_workload: string; src_namespace: string; dst_workload: string; dst_namespace: string; dst_port: number; has_policy: number }>
      for (const r of rows) {
        expect({ id: r.id, round, has: r.has_policy }).toEqual({ id: r.id, round, has: flowHasPolicy(r, policies) ? 1 : 0 })
      }
    }
  })
})

// Pins ingestion semantics so batching the writes can't change them:
// flow_count counts distinct connections (source ports), repeats of a
// connection only refresh verdict/last_seen, the latest verdict wins, and
// flows touching an ignored namespace land in ignored_flows.
describe('processFlow ingestion semantics', () => {
  const svc = (ns: string, name: string) => ({ namespace: ns, labels: [`k8s:app=${name}`], workloads: [{ name, kind: 'Deployment' }] })
  const msg = (opts: { srcPort: number; verdict?: string; srcNs?: string; dstNs?: string }) => ({ flow: {
    verdict: opts.verdict ?? 'FORWARDED',
    source: svc(opts.srcNs ?? 'frontend', 'app'),
    destination: svc(opts.dstNs ?? 'backend', 'worker'),
    ip: { source: '10.0.0.1', destination: '10.0.0.2' },
    l4: { TCP: { source_port: opts.srcPort, destination_port: 8080 } },
  } })
  const run = async (msgs: unknown[]) => {
    const mod = await import('./hubble') as typeof import('./hubble') & { flushFlowWrites?: () => void }
    for (const m of msgs) mod.__testing.processFlow(m)
    mod.flushFlowWrites?.()
  }
  const rows = (table: string) => getDb().prepare(`SELECT src_namespace, dst_namespace, verdict, flow_count FROM ${table}`).all() as Array<{ src_namespace: string; dst_namespace: string; verdict: string; flow_count: number }>

  it('counts distinct connections, treats a repeated connection as an update, and keeps the latest verdict', async () => {
    getDb().prepare('DELETE FROM discovered_flows').run()
    getDb().prepare('DELETE FROM ignored_flows').run()
    testConfig.ignored_namespaces = []
    await run([
      msg({ srcPort: 40001 }),
      msg({ srcPort: 40001 }),                       // same connection again: not a new one
      msg({ srcPort: 40002 }),                       // a second connection
      msg({ srcPort: 40002, verdict: 'DROPPED' }),   // latest verdict for the pair
    ])
    expect(rows('discovered_flows')).toEqual([{ src_namespace: 'frontend', dst_namespace: 'backend', verdict: 'DROPPED', flow_count: 2 }])
  })

  it('routes flows touching an ignored namespace to ignored_flows', async () => {
    getDb().prepare('DELETE FROM discovered_flows').run()
    getDb().prepare('DELETE FROM ignored_flows').run()
    const { invalidateIgnoredNamespacesCache } = await import('./hubble')
    testConfig.ignored_namespaces = ['kube-system']
    invalidateIgnoredNamespacesCache()
    await run([msg({ srcPort: 41001, srcNs: 'kube-system' })])
    testConfig.ignored_namespaces = []
    invalidateIgnoredNamespacesCache()
    expect(rows('discovered_flows')).toEqual([])
    expect(rows('ignored_flows')).toEqual([{ src_namespace: 'kube-system', dst_namespace: 'backend', verdict: 'FORWARDED', flow_count: 1 }])
  })
})

describe('retention, caps and unignore migration', () => {
  const db = () => getDb()
  const row = (table: string, id: string, srcNs: string, dstNs: string, lastSeen: string, count = 1) =>
    db().prepare(`INSERT INTO ${table} VALUES (?, 'app', ?, 'worker', ?, 8080, 'TCP', 'FORWARDED', ?, 0, ?, ?, 0)`).run(id, srcNs, dstNs, count, lastSeen, lastSeen)
  const ids = (table: string) => (db().prepare(`SELECT id FROM ${table} ORDER BY id`).all() as Array<{ id: string }>).map(r => r.id)

  it('moves flows back from ignored_flows only when neither side is still ignored, merging into existing rows', async () => {
    const { migrateUnignoredFlows } = await import('./hubble')
    db().prepare('DELETE FROM discovered_flows').run()
    db().prepare('DELETE FROM ignored_flows').run()
    row('discovered_flows', 'x', 'a', 'b', '2026-01-01T00:00:00Z', 2)
    row('ignored_flows', 'x', 'a', 'b', '2026-01-03T00:00:00Z', 3)
    row('ignored_flows', 'y', 'a', 'kube-system', '2026-01-01T00:00:00Z')
    migrateUnignoredFlows(['kube-system'])
    expect(ids('discovered_flows')).toEqual(['x'])
    expect(ids('ignored_flows')).toEqual(['y'])
    expect(db().prepare("SELECT flow_count, last_seen FROM discovered_flows WHERE id = 'x'").get())
      .toEqual({ flow_count: 5, last_seen: '2026-01-03T00:00:00Z' })
  })

  it('deletes rows past retention (internet on its own, shorter window) and starts a new generation', async () => {
    const { runRetentionCleanup, getDiscoveredFlowsSummary } = await import('./hubble')
    db().prepare('DELETE FROM discovered_flows').run()
    const now = Date.now()
    const daysAgo = (d: number) => new Date(now - d * 86400_000).toISOString()
    row('discovered_flows', 'old', 'a', 'b', daysAgo(8))
    row('discovered_flows', 'recent', 'a', 'b', daysAgo(2))
    row('discovered_flows', 'net-old', 'a', 'internet', daysAgo(2))
    row('discovered_flows', 'net-new', 'a', 'internet', daysAgo(0.1))
    const before = getDiscoveredFlowsSummary().version
    await runRetentionCleanup()
    expect(ids('discovered_flows')).toEqual(['net-new', 'recent'])
    expect(getDiscoveredFlowsSummary().version).not.toBe(before)
  })

  it('reports rows removed by retention in the delta instead of forcing a full reload', async () => {
    const { runRetentionCleanup, getDiscoveredFlowsSince } = await import('./hubble')
    db().prepare('DELETE FROM discovered_flows').run()
    const now = Date.now()
    row('discovered_flows', 'stale', 'a', 'b', new Date(now - 8 * 86400_000).toISOString())
    row('discovered_flows', 'fresh', 'a', 'b', new Date(now).toISOString())
    const held = getDiscoveredFlowsSince(null)
    await runRetentionCleanup()
    const delta = getDiscoveredFlowsSince(held.version)
    expect(delta.full).toBe(false)
    expect(delta.removed).toEqual(['stale'])
    expect(delta.flows).toEqual([])
    expect(delta.version).not.toBe(held.version)
  })

  it('caps a flow table at 50,000 rows by dropping the ones seen longest ago, so deltas keep working', async () => {
    const { capFlowTable, getDiscoveredFlowsSince } = await import('./hubble')
    db().prepare('DELETE FROM discovered_flows').run()
    const ins = db().prepare(`INSERT INTO discovered_flows VALUES (?, 'app', 'a', 'worker', 'b', 8080, 'TCP', 'FORWARDED', 1, 0, ?, ?, 0)`)
    db().transaction(() => {
      for (let i = 0; i < 50_003; i++) {
        const t = new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString()
        ins.run(`r${String(i).padStart(6, '0')}`, t, t)
      }
    })()
    const before = getDiscoveredFlowsSince(null)
    expect(getDiscoveredFlowsSince(before.version).full).toBe(true) // over the cap: no delta
    await capFlowTable('discovered_flows')
    expect((db().prepare('SELECT COUNT(*) AS c FROM discovered_flows').get() as { c: number }).c).toBe(50_000)
    expect(ids('discovered_flows').slice(0, 2)).toEqual(['r000003', 'r000004'])
    const after = getDiscoveredFlowsSince(null)
    expect(getDiscoveredFlowsSince(after.version).full).toBe(false)
  })
})
