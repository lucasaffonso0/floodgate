import { describe, it, expect } from 'vitest'
import { explainAccess, sourceIsExempt, isDestinationExempt } from './explainAccess'
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

describe('explainAccess', () => {
  it('is open when there are no policies at all', () => {
    const r = explainAccess('svc', 'ns', 'ingress', [])
    expect(r.blocked).toBe(false)
    expect(r.scope).toBe('none')
  })

  it('detects a service-scoped restrict with no exceptions', () => {
    const policies = [
      policy({ name: 'restrict-svc', policy_type: 'restrict-ingress', namespace: 'ns', dst_service: 'svc' }),
    ]
    const r = explainAccess('svc', 'ns', 'ingress', policies)
    expect(r.scope).toBe('service')
    expect(r.blocked).toBe(true)
    expect(r.exceptions).toHaveLength(0)
  })

  it('detects a namespace-wide restrict with no exceptions', () => {
    const policies = [
      policy({ name: 'ns-deny', policy_type: 'restrict-ingress', namespace: 'ns', dst_service: '' }),
    ]
    const r = explainAccess('svc', 'ns', 'ingress', policies)
    expect(r.scope).toBe('namespace')
    expect(r.blocked).toBe(true)
    expect(r.exceptions).toHaveLength(0)
  })

  it('treats an allow inside a namespace-wide restrict as an exception, not as open', () => {
    const policies = [
      policy({ name: 'ns-deny', policy_type: 'restrict-ingress', namespace: 'ns', dst_service: '' }),
      policy({ name: 'allow-svc', policy_type: 'allow', namespace: 'ns', dst_service: 'svc', src_workload: 'client', src_namespace: 'frontend' }),
    ]
    const r = explainAccess('svc', 'ns', 'ingress', policies)
    expect(r.scope).toBe('namespace')
    expect(r.exceptions).toHaveLength(1)
    expect(r.exceptions[0].kind).toBe('allow')
    expect(r.exceptions[0].scope).toBe('service')
  })

  it('marks both scopes when service and namespace restricts coexist (redundant)', () => {
    const policies = [
      policy({ name: 'ns-deny', policy_type: 'restrict-ingress', namespace: 'ns', dst_service: '' }),
      policy({ name: 'svc-deny', policy_type: 'restrict-ingress', namespace: 'ns', dst_service: 'svc' }),
    ]
    const r = explainAccess('svc', 'ns', 'ingress', policies)
    expect(r.scope).toBe('both')
  })

  it('leaves scope as service-only when namespace restrict is absent', () => {
    const policies = [
      policy({ name: 'svc-deny', policy_type: 'restrict-ingress', namespace: 'ns', dst_service: 'svc' }),
    ]
    const r = explainAccess('svc', 'ns', 'ingress', policies)
    expect(r.scope).toBe('service')
  })

  it('treats a service-scoped CIDR allow with no restrict policy as implicit lockdown', () => {
    const policies = [
      policy({ name: 'cidr-in', policy_type: 'cidr-ingress', namespace: 'ns', dst_service: 'svc' }),
    ]
    const r = explainAccess('svc', 'ns', 'ingress', policies)
    expect(r.scope).toBe('none')
    expect(r.blocked).toBe(true)
    expect(r.exceptions[0].scope).toBe('service')
  })

  it('treats a namespace-wide CIDR allow inside an isolated namespace as a namespace-scoped exception', () => {
    const policies = [
      policy({ name: 'ns-deny', policy_type: 'restrict-ingress', namespace: 'ns', dst_service: '' }),
      policy({ name: 'cidr-in-ns', policy_type: 'cidr-ingress', namespace: 'ns', dst_service: '' }),
    ]
    const r = explainAccess('svc', 'ns', 'ingress', policies)
    expect(r.scope).toBe('namespace')
    expect(r.exceptions[0].scope).toBe('namespace')
  })

  it('counts allow-intranamespace as a namespace-scoped egress exception', () => {
    const policies = [
      policy({ name: 'ns-deny-eg', policy_type: 'restrict-egress', namespace: 'ns', dst_service: '' }),
      policy({ name: 'intra-eg', policy_type: 'allow-intranamespace', namespace: 'ns', policy_types: ['Egress'] }),
    ]
    const r = explainAccess('svc', 'ns', 'egress', policies)
    expect(r.scope).toBe('namespace')
    expect(r.exceptions).toHaveLength(1)
    expect(r.exceptions[0].kind).toBe('allow-intranamespace')
    expect(r.exceptions[0].scope).toBe('namespace')
  })

  it('distinguishes the namespace-wide internet allow-egress from a per-workload allow-egress', () => {
    const policies = [
      policy({ name: 'egress-svc', policy_type: 'allow-egress', namespace: 'ns', src_workload: 'svc', src_namespace: 'ns', dst_service: 'other', dst_ports: [] }),
      policy({ name: 'egress-internet', policy_type: 'allow-egress', namespace: 'ns', src_workload: '', src_namespace: 'ns', dst_service: 'internet' }),
    ]
    const r = explainAccess('svc', 'ns', 'egress', policies)
    expect(r.exceptions).toHaveLength(2)
    const svcScoped = r.exceptions.find(e => e.label.includes('other'))
    const nsScoped = r.exceptions.find(e => e.label === 'internet')
    expect(svcScoped?.scope).toBe('service')
    expect(nsScoped?.scope).toBe('namespace')
  })
})

describe('sourceIsExempt / isDestinationExempt', () => {
  it('sourceIsExempt matches an exact per-workload ingress allow', () => {
    const policies = [policy({ policy_type: 'allow', namespace: 'backend', dst_service: 'worker', src_workload: 'app', src_namespace: 'frontend' })]
    const r = explainAccess('worker', 'backend', 'ingress', policies)
    expect(sourceIsExempt(r.exceptions, 'frontend', 'app', 'backend')).toBe(true)
    expect(sourceIsExempt(r.exceptions, 'frontend', 'other-workload', 'backend')).toBe(false)
  })

  it('sourceIsExempt matches an allow-namespace regardless of the specific workload', () => {
    const policies = [policy({ policy_type: 'allow-namespace', namespace: 'backend', dst_service: 'worker', src_namespace: 'frontend' })]
    const r = explainAccess('worker', 'backend', 'ingress', policies)
    expect(sourceIsExempt(r.exceptions, 'frontend', 'anything', 'backend')).toBe(true)
    expect(sourceIsExempt(r.exceptions, 'other-ns', 'anything', 'backend')).toBe(false)
  })

  // This is the exact bug the live cluster caught: an intra-namespace allow
  // in the DESTINATION's namespace must not exempt a source from a
  // completely different namespace just because "intra" showed up in the
  // exceptions list.
  it('sourceIsExempt does not let an intra-namespace allow exempt a source from a different namespace', () => {
    const policies = [policy({ policy_type: 'allow-intranamespace', namespace: 'backend', policy_types: ['Ingress'] })]
    const r = explainAccess('worker', 'backend', 'ingress', policies)
    expect(sourceIsExempt(r.exceptions, 'backend', 'other-svc', 'backend')).toBe(true) // same namespace: covered
    expect(sourceIsExempt(r.exceptions, 'frontend', 'app', 'backend')).toBe(false) // different namespace: not covered
  })

  it('isDestinationExempt matches a per-workload egress allow by destination service name', () => {
    const policies = [policy({ policy_type: 'allow-egress', namespace: 'frontend', src_workload: 'app', src_namespace: 'frontend', dst_service: 'worker' })]
    const r = explainAccess('app', 'frontend', 'egress', policies)
    expect(isDestinationExempt(r.exceptions, 'worker', 'frontend', 'backend')).toBe(true)
    expect(isDestinationExempt(r.exceptions, 'other-service', 'frontend', 'backend')).toBe(false)
  })

  it('isDestinationExempt matches a namespace-wide egress allow scoped to that destination', () => {
    const policies = [policy({ policy_type: 'allow-egress', namespace: 'frontend', src_workload: '', src_namespace: 'frontend', dst_service: 'worker' })]
    const r = explainAccess('app', 'frontend', 'egress', policies)
    expect(isDestinationExempt(r.exceptions, 'worker', 'frontend', 'backend')).toBe(true)
  })

  it('isDestinationExempt does not exempt an unrelated internet-only egress allow', () => {
    const policies = [policy({ policy_type: 'allow-egress', namespace: 'frontend', src_workload: '', src_namespace: 'frontend', dst_service: 'internet' })]
    const r = explainAccess('app', 'frontend', 'egress', policies)
    expect(isDestinationExempt(r.exceptions, 'worker', 'frontend', 'backend')).toBe(false)
  })

  // This is the exact bug the live cluster caught: frontend has an
  // intra-namespace egress allow (for its OWN pods talking to each other),
  // which must not exempt egress to a service in a totally different
  // namespace (backend) just because "intra" is present in the exceptions.
  it('isDestinationExempt does not let an intra-namespace egress allow exempt a cross-namespace destination', () => {
    const policies = [policy({ policy_type: 'allow-intranamespace', namespace: 'frontend', policy_types: ['Egress'] })]
    const r = explainAccess('app', 'frontend', 'egress', policies)
    expect(isDestinationExempt(r.exceptions, 'other-app-in-frontend', 'frontend', 'frontend')).toBe(true) // same namespace: covered
    expect(isDestinationExempt(r.exceptions, 'worker', 'frontend', 'backend')).toBe(false) // different namespace: not covered
  })
})
