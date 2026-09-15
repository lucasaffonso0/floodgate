import type { NetworkPolicyInfo } from '@/types'

// Strips the ReplicaSet/StatefulSet pod suffix (-<hash10>-<hash5> or -<hash5>)
// so a raw pod name matches the clean workload name stored on policy labels.
export function normalizeWorkload(workload: string): string {
  return workload
    .replace(/-[a-z0-9]{5,10}-[a-z0-9]{5}$/, '')
    .replace(/-[a-z0-9]{5}$/, '')
}

// Only an ALLOW-type policy that covers this exact src → dst:port means
// "nothing to create here": a restrict-ingress/egress anywhere in the
// namespace is why traffic gets dropped in the first place, and an allow
// that covers a *different* source doesn't cover this one.
export function flowHasPolicy(
  f: { src_workload: string; src_namespace: string; dst_workload: string; dst_namespace: string; dst_port: number },
  policies: NetworkPolicyInfo[],
): boolean {
  const srcWorkload = normalizeWorkload(f.src_workload)
  return policies.some(p => {
    if (p.namespace !== f.dst_namespace || p.dst_service !== f.dst_workload) return false
    const portMatches = p.dst_ports.some(ps => ps.port === f.dst_port) || p.dst_port === f.dst_port
    if (!portMatches) return false
    if (p.policy_type === 'allow') return p.src_workload === srcWorkload && p.src_namespace === f.src_namespace
    if (p.policy_type === 'allow-namespace') return p.src_namespace === f.src_namespace
    return false
  })
}
