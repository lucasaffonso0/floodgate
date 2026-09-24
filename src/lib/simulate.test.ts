import { describe, it, expect } from 'vitest'
import { isFlowBlocked, draftToPolicies, simulateImpact, computeEffectivePolicies } from './simulate'
import { NetworkPolicyInfo, Draft, CiliumFlowSummary } from '@/types'

function policy(overrides: Partial<NetworkPolicyInfo>): NetworkPolicyInfo {
  return {
    name: 'p', namespace: 'ns', src_workload: '', src_namespace: '', dst_service: '',
    dst_port: 0, dst_ports: [], policy_type: 'allow', managed: true,
    policy_types: [], pod_selector: {}, ingress_count: 0, egress_count: 0,
    ...overrides,
  }
}

function flow(overrides: Partial<CiliumFlowSummary>): CiliumFlowSummary {
  return {
    id: 'f1', src_workload: 'app', src_namespace: 'frontend',
    dst_workload: 'worker', dst_namespace: 'backend', dst_port: 8080, protocol: 'TCP',
    verdict: 'FORWARDED', flow_count: 1, has_policy: false,
    first_seen: '2026-01-01', last_seen: '2026-01-01',
    ...overrides,
  }
}

function draft(overrides: Partial<Draft>): Draft {
  return {
    id: 'd1', src_workload: '', src_namespace: '', dst_service: '', dst_namespace: '',
    dst_ports: [], policy_direction: 'ingress',
    ...overrides,
  }
}

describe('isFlowBlocked', () => {
  it('is false when nothing restricts either side', () => {
    expect(isFlowBlocked(flow({}), [])).toBe(false)
  })

  it('is true when the destination has an unexempted restrict-ingress', () => {
    const policies = [policy({ policy_type: 'restrict-ingress', namespace: 'backend', dst_service: '' })]
    expect(isFlowBlocked(flow({}), policies)).toBe(true)
  })

  it('is false when the destination restrict has an exception for this source', () => {
    const policies = [
      policy({ policy_type: 'restrict-ingress', namespace: 'backend', dst_service: '' }),
      policy({ policy_type: 'allow', namespace: 'backend', dst_service: 'worker', src_workload: 'app', src_namespace: 'frontend' }),
    ]
    expect(isFlowBlocked(flow({}), policies)).toBe(false)
  })

  it('is true when the source has an unexempted restrict-egress, even with the destination open', () => {
    const policies = [policy({ policy_type: 'restrict-egress', namespace: 'frontend', dst_service: '' })]
    expect(isFlowBlocked(flow({}), policies)).toBe(true)
  })
})

describe('draftToPolicies', () => {
  it('builds an allow policy for an ingress connection draft', () => {
    const d = draft({ src_workload: 'app', src_namespace: 'frontend', dst_service: 'worker', dst_namespace: 'backend', dst_ports: [{ port: 8080, protocol: 'TCP' }], policy_direction: 'ingress' })
    const result = draftToPolicies(d)
    expect(result).toHaveLength(1)
    expect(result[0].policy_type).toBe('allow')
    expect(result[0].namespace).toBe('backend')
    expect(result[0].dst_service).toBe('worker')
  })

  it('builds both an allow and an allow-egress policy for a "both" direction draft', () => {
    const d = draft({ src_workload: 'app', src_namespace: 'frontend', dst_service: 'worker', dst_namespace: 'backend', policy_direction: 'both' })
    const result = draftToPolicies(d)
    expect(result.map(p => p.policy_type).sort()).toEqual(['allow', 'allow-egress'])
  })

  it('builds a namespace-wide restrict-ingress + restrict-egress for an isolate draft with both directions', () => {
    const d = draft({ kind: 'isolate', isolate_namespace: 'backend', isolate_direction: 'both', isolate_allow_intra: false, isolate_allow_internet: false })
    const result = draftToPolicies(d)
    expect(result).toHaveLength(2)
    expect(result.every(p => p.dst_service === '')).toBe(true)
    expect(result.map(p => p.policy_type).sort()).toEqual(['restrict-egress', 'restrict-ingress'])
  })

  it('adds allow-intranamespace and internet-egress companions for an isolate draft when requested', () => {
    const d = draft({ kind: 'isolate', isolate_namespace: 'backend', isolate_direction: 'egress', isolate_allow_intra: true, isolate_allow_internet: true })
    const result = draftToPolicies(d)
    expect(result.map(p => p.policy_type).sort()).toEqual(['allow-egress', 'allow-intranamespace', 'restrict-egress'])
  })

  it('builds a per-service restrict policy for a restrict draft', () => {
    const d = draft({ kind: 'restrict', restrict_service: 'worker', restrict_namespace: 'backend', restrict_direction: 'ingress' })
    const result = draftToPolicies(d)
    expect(result).toEqual([expect.objectContaining({ policy_type: 'restrict-ingress', namespace: 'backend', dst_service: 'worker' })])
  })

  it('builds an allow-intranamespace per requested direction for an "enable" intra toggle', () => {
    const d = draft({ kind: 'toggle', toggle_namespace: 'backend', toggle_option: 'intra', toggle_action: 'enable', toggle_directions: ['ingress', 'egress'] })
    const result = draftToPolicies(d)
    expect(result).toHaveLength(2)
    expect(result.every(p => p.policy_type === 'allow-intranamespace' && p.namespace === 'backend')).toBe(true)
  })

  it('builds the internet-egress companion for an "enable" internet toggle', () => {
    const d = draft({ kind: 'toggle', toggle_namespace: 'backend', toggle_option: 'internet', toggle_action: 'enable' })
    const result = draftToPolicies(d)
    expect(result).toEqual([expect.objectContaining({ policy_type: 'allow-egress', namespace: 'backend', dst_service: 'internet' })])
  })

  it('fabricates nothing for a "disable" toggle: its effect is excluding a real policy, not adding one', () => {
    const d = draft({ kind: 'toggle', toggle_namespace: 'backend', toggle_option: 'intra', toggle_action: 'disable' })
    expect(draftToPolicies(d)).toEqual([])
  })

  it('fabricates nothing for a "remove" draft: its effect is excluding real policies, not adding one', () => {
    const d = draft({ kind: 'remove', remove_namespace: 'backend', remove_policy_names: ['floodgate-ns-deny-ingress-backend'] })
    expect(draftToPolicies(d)).toEqual([])
  })
})

describe('computeEffectivePolicies', () => {
  it('excludes the real allow-intranamespace policy matched by a "disable" toggle draft', () => {
    const real = [policy({ policy_type: 'allow-intranamespace', namespace: 'backend' })]
    const drafts = [draft({ kind: 'toggle', toggle_namespace: 'backend', toggle_option: 'intra', toggle_action: 'disable' })]
    const result = computeEffectivePolicies(real, drafts)
    expect(result.some(p => p.policy_type === 'allow-intranamespace')).toBe(false)
  })

  it('leaves unrelated real policies untouched by a "disable" toggle draft for a different namespace', () => {
    const real = [policy({ policy_type: 'allow-intranamespace', namespace: 'frontend' })]
    const drafts = [draft({ kind: 'toggle', toggle_namespace: 'backend', toggle_option: 'intra', toggle_action: 'disable' })]
    const result = computeEffectivePolicies(real, drafts)
    expect(result).toEqual(real)
  })

  it('adds the fabricated companion for an "enable" toggle on top of the real policies', () => {
    const real = [policy({ policy_type: 'restrict-egress', namespace: 'backend', dst_service: '' })]
    const drafts = [draft({ kind: 'toggle', toggle_namespace: 'backend', toggle_option: 'internet', toggle_action: 'enable' })]
    const result = computeEffectivePolicies(real, drafts)
    expect(result).toHaveLength(2)
    expect(result.some(p => p.policy_type === 'allow-egress' && p.dst_service === 'internet')).toBe(true)
  })

  it('excludes the real policies named by a "remove" draft: e.g. undoing namespace isolation must not apply live while staged', () => {
    const real = [
      policy({ name: 'floodgate-ns-deny-ingress-backend', policy_type: 'restrict-ingress', namespace: 'backend', dst_service: '' }),
      policy({ name: 'floodgate-intra-ingress-backend', policy_type: 'allow-intranamespace', namespace: 'backend' }),
      policy({ name: 'unrelated', policy_type: 'allow', namespace: 'backend', dst_service: 'worker' }),
    ]
    const drafts = [draft({ kind: 'remove', remove_namespace: 'backend', remove_policy_names: ['floodgate-ns-deny-ingress-backend', 'floodgate-intra-ingress-backend'] })]
    const result = computeEffectivePolicies(real, drafts)
    expect(result).toEqual([real[2]])
  })

  it('leaves unrelated real policies untouched by a "remove" draft for a different namespace', () => {
    const real = [policy({ name: 'p', policy_type: 'restrict-ingress', namespace: 'frontend', dst_service: '' })]
    const drafts = [draft({ kind: 'remove', remove_namespace: 'backend', remove_policy_names: ['p'] })]
    expect(computeEffectivePolicies(real, drafts)).toEqual(real)
  })
})

describe('simulateImpact', () => {
  it('flags a flow as breaking when an isolate draft would newly block it', () => {
    const flows = [flow({})]
    const realPolicies: NetworkPolicyInfo[] = []
    const drafts = [draft({ kind: 'isolate', isolate_namespace: 'backend', isolate_direction: 'egress', isolate_allow_intra: false, isolate_allow_internet: false })]
    // isolating backend's egress doesn't block this ingress flow (backend is
    // the destination here, not the source); use frontend instead to break it
    const drafts2 = [draft({ kind: 'isolate', isolate_namespace: 'frontend', isolate_direction: 'egress', isolate_allow_intra: false, isolate_allow_internet: false })]
    expect(simulateImpact(flows, realPolicies, drafts).breaking).toEqual([])
    expect(simulateImpact(flows, realPolicies, drafts2).breaking.map(f => f.id)).toEqual(['f1'])
  })

  it('flags a flow as fixed when a connection draft newly allows it through an existing restrict', () => {
    const flows = [flow({})]
    const realPolicies = [policy({ policy_type: 'restrict-ingress', namespace: 'backend', dst_service: '' })]
    const drafts = [draft({ src_workload: 'app', src_namespace: 'frontend', dst_service: 'worker', dst_namespace: 'backend', dst_ports: [{ port: 8080, protocol: 'TCP' }], policy_direction: 'ingress' })]
    const result = simulateImpact(flows, realPolicies, drafts)
    expect(result.fixed.map(f => f.id)).toEqual(['f1'])
    expect(result.breaking).toEqual([])
  })

  it('reports neither breaking nor fixed when a draft does not affect this flow', () => {
    const flows = [flow({})]
    const realPolicies: NetworkPolicyInfo[] = []
    const drafts = [draft({ kind: 'isolate', isolate_namespace: 'monitoring', isolate_direction: 'both' })]
    const result = simulateImpact(flows, realPolicies, drafts)
    expect(result.breaking).toEqual([])
    expect(result.fixed).toEqual([])
  })

  it('flags a flow as breaking when a "disable intra" toggle draft removes the exception it depends on', () => {
    // Same-namespace flow that only passes today because of the intra-namespace
    // exception on top of a namespace-wide restrict, same shape as
    // auth-service -> session-cache inside "identity".
    const flows = [flow({ src_workload: 'auth', src_namespace: 'identity', dst_workload: 'cache', dst_namespace: 'identity' })]
    const realPolicies = [
      policy({ policy_type: 'restrict-ingress', namespace: 'identity', dst_service: '' }),
      policy({ policy_type: 'allow-intranamespace', namespace: 'identity', policy_types: ['Ingress'] }),
    ]
    const drafts = [draft({ kind: 'toggle', toggle_namespace: 'identity', toggle_option: 'intra', toggle_action: 'disable' })]
    const result = simulateImpact(flows, realPolicies, drafts)
    expect(result.breaking.map(f => f.id)).toEqual(['f1'])
  })
})
