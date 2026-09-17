import { describe, it, expect } from 'vitest'
import { getNamespaceIsolation } from './nsIsolation'
import { NetworkPolicyInfo } from '@/types'

function policy(overrides: Partial<NetworkPolicyInfo>): NetworkPolicyInfo {
  return {
    name: 'p',
    namespace: 'ns',
    src_workload: '',
    src_namespace: '',
    dst_service: '',
    dst_port: 0,
    dst_ports: [],
    policy_type: 'allow',
    managed: true,
    policy_types: [],
    pod_selector: {},
    ingress_count: 0,
    egress_count: 0,
    ...overrides,
  }
}

describe('getNamespaceIsolation', () => {
  it('is not isolated when there are no policies at all', () => {
    const r = getNamespaceIsolation('ns', [])
    expect(r.anyIsolated).toBe(false)
    expect(r.fullyIsolated).toBe(false)
  })

  it('detects a namespace-wide ingress restrict', () => {
    const policies = [policy({ name: 'ns-deny-in', policy_type: 'restrict-ingress', namespace: 'ns', dst_service: '' })]
    const r = getNamespaceIsolation('ns', policies)
    expect(r.isolatedIn).toBe(true)
    expect(r.isolatedEg).toBe(false)
    expect(r.anyIsolated).toBe(true)
    expect(r.fullyIsolated).toBe(false)
    expect(r.ingressPolicy?.name).toBe('ns-deny-in')
  })

  it('is fully isolated when both directions have namespace-wide restrict policies', () => {
    const policies = [
      policy({ name: 'ns-deny-in', policy_type: 'restrict-ingress', namespace: 'ns', dst_service: '' }),
      policy({ name: 'ns-deny-eg', policy_type: 'restrict-egress',  namespace: 'ns', dst_service: '' }),
    ]
    const r = getNamespaceIsolation('ns', policies)
    expect(r.fullyIsolated).toBe(true)
  })

  // The bug this helper fixes: a per-service restrict policy must NOT count
  // as namespace isolation — only dst_service === '' (podSelector: {}) does.
  it('does not count a per-service restrict policy as namespace isolation', () => {
    const policies = [policy({ name: 'restrict-svc', policy_type: 'restrict-ingress', namespace: 'ns', dst_service: 'svc' })]
    const r = getNamespaceIsolation('ns', policies)
    expect(r.isolatedIn).toBe(false)
    expect(r.anyIsolated).toBe(false)
  })

  it('ignores policies from other namespaces', () => {
    const policies = [policy({ name: 'other-ns-deny', policy_type: 'restrict-ingress', namespace: 'other', dst_service: '' })]
    const r = getNamespaceIsolation('ns', policies)
    expect(r.anyIsolated).toBe(false)
  })
})
