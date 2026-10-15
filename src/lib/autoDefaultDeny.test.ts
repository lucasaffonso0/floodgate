import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NetworkPolicyInfo } from '@/types'

vi.mock('server-only', () => ({}))
const k8s = vi.hoisted(() => ({ listServices: vi.fn(), listNetworkPolicies: vi.fn(), isolateNamespace: vi.fn() }))
vi.mock('./k8s', () => k8s)
const cfg = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
  baseline: [] as string[],
}))
vi.mock('./config', () => ({
  getConfig: () => cfg.value,
  namespaceWatchFilter: () => (ns: string) => ns !== 'kube-system',
  getAutoDefaultDenyBaseline: () => cfg.baseline,
}))
const paused = vi.hoisted(() => ({ n: 0 }))
vi.mock('./db', () => ({ getDb: () => ({ prepare: () => ({ get: () => ({ n: paused.n }) }) }) }))
const logAudit = vi.hoisted(() => vi.fn())
vi.mock('./audit', () => ({ logAudit }))
vi.mock('./autosync', () => ({ trackIsolatedPolicies: vi.fn() }))
const writeMode = vi.hoisted(() => ({ mode: 'direct' }))
vi.mock('./writeMode', () => ({ getWriteMode: () => writeMode.mode }))

const { runAutoDefaultDeny, computeSecurityCoverage } = await import('./autoDefaultDeny')

const svc = (namespace: string, name = 'app') => ({ namespace, name, selector: {}, ports: [] })
const policy = (o: Partial<NetworkPolicyInfo>): NetworkPolicyInfo => ({
  name: 'p', namespace: 'ns', src_workload: '', src_namespace: '', dst_service: '', dst_port: 0, dst_ports: [],
  policy_type: 'allow', managed: true, policy_types: [], pod_selector: {}, ingress_count: 0, egress_count: 0, ...o,
})

beforeEach(() => {
  vi.clearAllMocks()
  cfg.value = { auto_default_deny_enabled: true, auto_default_deny_direction: 'both', auto_default_deny_allow_intra: false, auto_default_deny_allow_internet: false, auto_default_deny_scope: 'all' }
  cfg.baseline = []
  paused.n = 0
  writeMode.mode = 'direct'
  k8s.isolateNamespace.mockResolvedValue({ created: 1, skipped: 0 })
  k8s.listServices.mockResolvedValue([svc('web'), svc('jobs'), svc('kube-system'), svc('floodgate')])
  k8s.listNetworkPolicies.mockResolvedValue([policy({ namespace: 'jobs', policy_type: 'restrict-ingress' })])
})

const isolated = () => k8s.isolateNamespace.mock.calls.map(([r]) => `${r.namespace}:${r.direction}`).sort()

describe('runAutoDefaultDeny', () => {
  it('fills in only the missing directions of watched namespaces, audited as system', async () => {
    await runAutoDefaultDeny()
    expect(isolated()).toEqual(['jobs:egress', 'web:egress', 'web:ingress'])
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({ username: 'system', action: 'auto_default_deny_ingress', namespace: 'web' }))
  })

  it('does nothing when disabled, while paused, or under GitOps', async () => {
    cfg.value.auto_default_deny_enabled = false
    await runAutoDefaultDeny()
    cfg.value.auto_default_deny_enabled = true
    paused.n = 3
    await runAutoDefaultDeny()
    paused.n = 0
    writeMode.mode = 'gitops'
    await runAutoDefaultDeny()
    expect(k8s.isolateNamespace).not.toHaveBeenCalled()
  })

  it('future_only: never touches namespaces in the baseline', async () => {
    cfg.value.auto_default_deny_scope = 'future_only'
    cfg.baseline = ['web']
    await runAutoDefaultDeny()
    expect(isolated()).toEqual(['jobs:egress'])
  })

  it('re-applies when an extra (internet egress) was turned on after the namespace was already denied', async () => {
    cfg.value.auto_default_deny_direction = 'egress'
    cfg.value.auto_default_deny_allow_internet = true
    k8s.listServices.mockResolvedValue([svc('web')])
    k8s.listNetworkPolicies.mockResolvedValue([policy({ namespace: 'web', policy_type: 'restrict-egress' })])
    await runAutoDefaultDeny()
    expect(k8s.isolateNamespace).toHaveBeenCalledWith({ namespace: 'web', direction: 'egress', allow_intra_namespace: false, allow_egress_internet: true })
  })
})

describe('computeSecurityCoverage', () => {
  it('reports watched namespaces only, without side effects', () => {
    const cov = computeSecurityCoverage([svc('web'), svc('web', 'api'), svc('kube-system'), svc('floodgate')], [policy({ namespace: 'web', policy_type: 'restrict-egress' })])
    expect(cov).toEqual([{ namespace: 'web', service_count: 2, has_deny_ingress: false, has_deny_egress: true, managed_policy_count: 1 }])
  })
})
