import { describe, it, expect } from 'vitest'
import { normalizeWorkload, flowHasPolicy, classifyFlowGap, isWorldEndpoint } from './flowMatch'
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

describe('isWorldEndpoint', () => {
  it('is true when labels include reserved:world', () => {
    expect(isWorldEndpoint(['reserved:world'])).toBe(true)
    expect(isWorldEndpoint(['k8s:io.kubernetes.pod.namespace=x', 'reserved:world'])).toBe(true)
  })

  it('is false for a normal in-cluster pod\'s labels', () => {
    expect(isWorldEndpoint(['k8s:app=worker', 'k8s:io.kubernetes.pod.namespace=backend'])).toBe(false)
  })

  it('is false for other reserved identities — only world should turn into a shown flow', () => {
    expect(isWorldEndpoint(['reserved:host'])).toBe(false)
    expect(isWorldEndpoint(['reserved:unmanaged'])).toBe(false)
    expect(isWorldEndpoint(['reserved:kube-apiserver'])).toBe(false)
  })

  it('is false for missing/empty labels, without throwing', () => {
    expect(isWorldEndpoint(undefined)).toBe(false)
    expect(isWorldEndpoint(null)).toBe(false)
    expect(isWorldEndpoint([])).toBe(false)
  })
})

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

  it('does not double-strip a multi-word workload whose last word is itself 5 chars', () => {
    // Regression: "session-cache-6949b89dcc-9w42f" correctly strips the
    // ReplicaSet+pod suffix to "session-cache" via the first pattern, but a
    // second, chained pass used to also strip the legitimate "-cache",
    // leaving just "session" — which then 404'd against the real Service.
    expect(normalizeWorkload('session-cache-6949b89dcc-9w42f')).toBe('session-cache')
    expect(normalizeWorkload('session-cache-584c8f55b5-89rdj')).toBe('session-cache')
  })

  it('leaves an already-clean multi-word name untouched even with no suffix to strip', () => {
    // Cilium sometimes resolves the owner workload directly (no pod-hash
    // suffix attached at all) — "session-cache" on its own used to still
    // fall through to the single-suffix fallback, which matched "-cache"
    // (5 chars) as if it were a random pod hash.
    expect(normalizeWorkload('session-cache')).toBe('session-cache')
    expect(normalizeWorkload('email-sender')).toBe('email-sender')
  })

  it('still strips a single-suffix hash even when the base name itself has vowels', () => {
    expect(normalizeWorkload('email-sender-9w42f')).toBe('email-sender')
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

  describe('internet-bound flows (dst_namespace: "internet")', () => {
    const internetFlow = { src_workload: 'app', src_namespace: 'frontend', dst_workload: '1.1.1.1', dst_namespace: 'internet', dst_port: 443 }

    it('is true when the source namespace has no egress restriction at all', () => {
      expect(flowHasPolicy(internetFlow, [])).toBe(true)
    })

    it('is false when the source namespace has an unexempted egress-deny', () => {
      const policies = [policy({ policy_type: 'restrict-egress', namespace: 'frontend', dst_service: '' })]
      expect(flowHasPolicy(internetFlow, policies)).toBe(false)
    })

    it('is true when the source namespace has an egress-deny but the internet-egress companion (dst_service: "internet") exempts it', () => {
      const policies = [
        policy({ policy_type: 'restrict-egress', namespace: 'frontend', dst_service: '' }),
        policy({ policy_type: 'allow-egress', namespace: 'frontend', src_workload: 'app', src_namespace: 'frontend', dst_service: 'internet' }),
      ]
      expect(flowHasPolicy(internetFlow, policies)).toBe(true)
    })

    it('ignores a real policy that happens to share the literal destination IP as dst_service — no create-policy flow can ever produce that', () => {
      const policies = [
        policy({ policy_type: 'restrict-egress', namespace: 'frontend', dst_service: '' }),
        policy({ policy_type: 'allow-egress', namespace: 'frontend', src_workload: 'app', src_namespace: 'frontend', dst_service: '1.1.1.1' }),
      ]
      expect(flowHasPolicy(internetFlow, policies)).toBe(false)
    })

    it('never matches against a dst_namespace that is a real cluster namespace, even one literally named "internet"', () => {
      // Documents the known v1 edge case rather than silently mishandling
      // it: a real allow-namespace policy for a namespace named "internet"
      // is NOT what dst_namespace: 'internet' means for a flow — the
      // sentinel and a same-named real namespace are indistinguishable
      // here on purpose (see flowHasPolicy's internet branch), since this
      // function only ever checks the source's egress posture for it.
      const policies = [
        policy({ policy_type: 'allow-namespace', namespace: 'internet', dst_service: 'x', src_namespace: 'frontend', dst_ports: [{ port: 443, protocol: 'TCP' }] }),
      ]
      expect(flowHasPolicy(internetFlow, policies)).toBe(true) // true only because src has no egress restriction, not because of this policy
    })
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
