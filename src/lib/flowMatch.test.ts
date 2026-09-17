import { describe, it, expect } from 'vitest'
import { normalizeWorkload, flowHasPolicy, classifyFlowGap } from './flowMatch'
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

describe('normalizeWorkload', () => {
  it('strips a ReplicaSet-style pod suffix (10-char hash + 5-char hash)', () => {
    expect(normalizeWorkload('app-8646c6995-mj4p9')).toBe('app')
  })

  it('strips a Deployment/ReplicaSet suffix with a shorter hash', () => {
    expect(normalizeWorkload('worker-584c8f55b5-89rdj')).toBe('worker')
  })

  it('strips a StatefulSet-style ordinal-less suffix (single 5-char hash)', () => {
    expect(normalizeWorkload('grafana-mj4p9')).toBe('grafana')
  })

  it('leaves an already-clean workload name untouched', () => {
    expect(normalizeWorkload('worker')).toBe('worker')
  })

  it('leaves a multi-word service name untouched when it has no pod suffix', () => {
    expect(normalizeWorkload('api-gateway')).toBe('api-gateway')
  })
})

describe('flowHasPolicy', () => {
  const flow = { src_workload: 'app', src_namespace: 'frontend', dst_workload: 'worker', dst_namespace: 'backend', dst_port: 8080 }

  it('is false when there are no policies', () => {
    expect(flowHasPolicy(flow, [])).toBe(false)
  })

  it('is true when an allow covers this exact source, destination and port', () => {
    const policies = [policy({ policy_type: 'allow', namespace: 'backend', dst_service: 'worker', src_workload: 'app', src_namespace: 'frontend', dst_ports: [{ port: 8080, protocol: 'TCP' }] })]
    expect(flowHasPolicy(flow, policies)).toBe(true)
  })

  it('is false when the allow covers the same destination:port but a different source', () => {
    // This is the exact bug that shipped: app→worker:8080 was DROPPED, but an
    // unrelated allow for grafana→worker:8080 made it look covered.
    const policies = [policy({ policy_type: 'allow', namespace: 'backend', dst_service: 'worker', src_workload: 'grafana', src_namespace: 'monitoring', dst_ports: [{ port: 8080, protocol: 'TCP' }] })]
    expect(flowHasPolicy(flow, policies)).toBe(false)
  })

  it('is false when the allow covers the right source/destination but a different port', () => {
    const policies = [policy({ policy_type: 'allow', namespace: 'backend', dst_service: 'worker', src_workload: 'app', src_namespace: 'frontend', dst_ports: [{ port: 9090, protocol: 'TCP' }] })]
    expect(flowHasPolicy(flow, policies)).toBe(false)
  })

  it('matches the raw pod name against the clean policy label after normalization', () => {
    const rawFlow = { ...flow, src_workload: 'app-8646c6995-mj4p9' }
    const policies = [policy({ policy_type: 'allow', namespace: 'backend', dst_service: 'worker', src_workload: 'app', src_namespace: 'frontend', dst_ports: [{ port: 8080, protocol: 'TCP' }] })]
    expect(flowHasPolicy(rawFlow, policies)).toBe(true)
  })

  it('is true for any source in the namespace when covered by allow-namespace', () => {
    const policies = [policy({ policy_type: 'allow-namespace', namespace: 'backend', dst_service: 'worker', src_namespace: 'frontend', dst_ports: [{ port: 8080, protocol: 'TCP' }] })]
    expect(flowHasPolicy(flow, policies)).toBe(true)
  })

  it('ignores a restrict-ingress/egress policy anywhere in the namespace: it is why traffic is dropped, not proof it is covered', () => {
    const policies = [
      policy({ policy_type: 'restrict-ingress', namespace: 'backend', dst_service: '' }),
      policy({ policy_type: 'restrict-ingress', namespace: 'backend', dst_service: 'worker' }),
    ]
    expect(flowHasPolicy(flow, policies)).toBe(false)
  })

  it('ignores policies in a different namespace even if names match', () => {
    const policies = [policy({ policy_type: 'allow', namespace: 'other-ns', dst_service: 'worker', src_workload: 'app', src_namespace: 'frontend', dst_ports: [{ port: 8080, protocol: 'TCP' }] })]
    expect(flowHasPolicy(flow, policies)).toBe(false)
  })

  it('is false when the destination allows ingress but the source namespace has an unexempted namespace-wide egress-deny (the exact bug reported live: backend allowed app in, but frontend never let it out)', () => {
    const policies = [
      policy({ policy_type: 'allow', namespace: 'backend', dst_service: 'worker', src_workload: 'app', src_namespace: 'frontend', dst_ports: [{ port: 8080, protocol: 'TCP' }] }),
      policy({ policy_type: 'restrict-egress', namespace: 'frontend', dst_service: '' }),
    ]
    expect(flowHasPolicy(flow, policies)).toBe(false)
  })

  it('is true when the source has a namespace-wide egress-deny but also a specific egress-allow exception covering this destination', () => {
    const policies = [
      policy({ policy_type: 'allow', namespace: 'backend', dst_service: 'worker', src_workload: 'app', src_namespace: 'frontend', dst_ports: [{ port: 8080, protocol: 'TCP' }] }),
      policy({ policy_type: 'restrict-egress', namespace: 'frontend', dst_service: '' }),
      policy({ policy_type: 'allow-egress', namespace: 'frontend', src_workload: 'app', src_namespace: 'frontend', dst_service: 'worker' }),
    ]
    expect(flowHasPolicy(flow, policies)).toBe(true)
  })

  it('is true when the source namespace has no egress restriction at all, even without any egress-allow', () => {
    const policies = [
      policy({ policy_type: 'allow', namespace: 'backend', dst_service: 'worker', src_workload: 'app', src_namespace: 'frontend', dst_ports: [{ port: 8080, protocol: 'TCP' }] }),
    ]
    expect(flowHasPolicy(flow, policies)).toBe(true)
  })
})

describe('classifyFlowGap', () => {
  const flow = { src_workload: 'app', src_namespace: 'frontend', dst_workload: 'worker', dst_namespace: 'backend', dst_port: 8080 }

  it('flags neither side when nothing restricts ingress or egress (destination wide open)', () => {
    const policies: NetworkPolicyInfo[] = []
    expect(classifyFlowGap(flow, policies)).toEqual({ missingIngress: false, missingEgress: false })
  })

  it('flags only missing ingress when the destination has a restrict-ingress with no exception and the source has no egress restriction', () => {
    const policies = [
      policy({ policy_type: 'restrict-ingress', namespace: 'backend', dst_service: '' }),
    ]
    expect(classifyFlowGap(flow, policies)).toEqual({ missingIngress: true, missingEgress: false })
  })

  it('flags only missing egress when the destination has no policy at all (open) but the source egress is blocked (the reported bug: worker -> pgbouncer)', () => {
    const policies = [
      policy({ policy_type: 'restrict-egress', namespace: 'frontend', dst_service: '' }),
    ]
    expect(classifyFlowGap(flow, policies)).toEqual({ missingIngress: false, missingEgress: true })
  })

  it('flags both missing when the destination has a restrict-ingress and the source has a restrict-egress, neither with an exception', () => {
    const policies = [
      policy({ policy_type: 'restrict-ingress', namespace: 'backend', dst_service: '' }),
      policy({ policy_type: 'restrict-egress', namespace: 'frontend', dst_service: '' }),
    ]
    expect(classifyFlowGap(flow, policies)).toEqual({ missingIngress: true, missingEgress: true })
  })
})
