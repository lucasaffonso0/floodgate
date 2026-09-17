import { NetworkPolicyInfo } from '@/types'

export interface NamespaceIsolation {
  ingressPolicy: NetworkPolicyInfo | undefined
  egressPolicy: NetworkPolicyInfo | undefined
  isolatedIn: boolean
  isolatedEg: boolean
  anyIsolated: boolean
  fullyIsolated: boolean
}

// Single source of truth for "is this namespace isolated?" — a namespace is
// isolated by a namespace-wide restrict policy (dst_service === ''), not by
// per-service restrict policies. Used by the graph's namespace panel, the
// Segurança tab, and the security-coverage auto-apply route so all three
// always agree.
export function getNamespaceIsolation(namespace: string, policies: NetworkPolicyInfo[]): NamespaceIsolation {
  const ingressPolicy = policies.find(p => p.namespace === namespace && p.policy_type === 'restrict-ingress' && p.dst_service === '')
  const egressPolicy  = policies.find(p => p.namespace === namespace && p.policy_type === 'restrict-egress'  && p.dst_service === '')
  return {
    ingressPolicy,
    egressPolicy,
    isolatedIn: !!ingressPolicy,
    isolatedEg: !!egressPolicy,
    anyIsolated: !!ingressPolicy || !!egressPolicy,
    fullyIsolated: !!ingressPolicy && !!egressPolicy,
  }
}
