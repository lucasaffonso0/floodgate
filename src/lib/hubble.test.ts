import { describe, it, expect } from 'vitest'
import { vi } from 'vitest'
import type { NetworkPolicyInfo } from '@/types'

vi.mock('server-only', () => ({}))
vi.mock('./db', () => ({ getDb: () => ({ prepare: () => ({ get: () => ({ n: 0 }), all: () => [], run: () => {} }) }) }))
vi.mock('./k8s', () => ({ listNetworkPolicies: vi.fn(), checkHubbleRelayReady: vi.fn(), listServices: vi.fn() }))
vi.mock('./config', () => ({ getConfig: () => ({ ignored_namespaces: [], hubble_flow_retention_days: 7, hubble_internet_flow_retention_days: 1 }) }))
vi.mock('./sse', () => ({ emit: vi.fn() }))

const { __testing } = await import('./hubble')
const { policyFingerprint, excludeUnappliedGitOps } = __testing

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
