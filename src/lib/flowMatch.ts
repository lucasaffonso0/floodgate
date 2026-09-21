import type { NetworkPolicyInfo } from '@/types'
import { explainAccess, sourceIsExempt, isDestinationExempt } from './explainAccess'

// Strips the ReplicaSet/StatefulSet pod suffix (-<hash10>-<hash5> or -<hash5>)
// so a raw pod name matches the clean workload name stored on policy labels.
//
// Two defenses against false-positive stripping of a legitimate service name
// whose last word happens to look like a hash:
//
// 1. The hash character class excludes vowels. Kubernetes generates these
//    suffixes with utilrand.String(), whose alphabet (bcdfghjklmnpqrstvwxz +
//    digits) never contains a/e/i/o/u — so a real hash can never collide
//    with an ordinary English word. This is what actually saves names like
//    "session-cache" or "email-sender": "cache"/"email" contain vowels and
//    so never match the hash class, hash or no hash attached.
// 2. The two patterns are tried, not chained — if the two-suffix pattern
//    already matched, the single-suffix fallback is never applied on top of
//    its result. (Kept as defense in depth; (1) alone already prevents the
//    double-strip for any name that fails the vowel test, but this avoids
//    relying on that alone.)
const HASH = '[bcdfghjklmnpqrstvwxz0-9]'
export function normalizeWorkload(workload: string): string {
  const twoSuffix = new RegExp(`-${HASH}{5,10}-${HASH}{5}$`)
  const oneSuffix = new RegExp(`-${HASH}{5}$`)
  const stripped = workload.replace(twoSuffix, '')
  if (stripped !== workload) return stripped
  return workload.replace(oneSuffix, '')
}

// Which side is actually the reason this flow gets dropped: the
// destination's ingress, the source's egress, or both. Unlike
// flowHasPolicy() (which requires an explicit allow to call ingress
// "covered"), this only flags a side as missing when it's genuinely
// blocked — a destination with no restrict-ingress at all is open, so
// there's nothing to create there even without an explicit allow.
export function classifyFlowGap(
  f: { src_workload: string; src_namespace: string; dst_workload: string; dst_namespace: string; dst_port: number },
  policies: NetworkPolicyInfo[],
): { missingIngress: boolean; missingEgress: boolean } {
  const srcWorkload = normalizeWorkload(f.src_workload)
  const dstWorkload = normalizeWorkload(f.dst_workload)

  const dstExplain = explainAccess(dstWorkload, f.dst_namespace, 'ingress', policies)
  const missingIngress = dstExplain.blocked && !sourceIsExempt(dstExplain.exceptions, f.src_namespace, srcWorkload, f.dst_namespace)

  const srcExplain = explainAccess(srcWorkload, f.src_namespace, 'egress', policies)
  const missingEgress = srcExplain.blocked && !isDestinationExempt(srcExplain.exceptions, dstWorkload, f.src_namespace, f.dst_namespace)

  return { missingIngress, missingEgress }
}

// has_policy: true only when an explicit allow (not just "nothing is
// blocking it") covers this exact source, destination and port — drives
// the "com política" badge and the "Sem política" counter, so it must stay
// strict even though classifyFlowGap() (button-direction diagnosis) does not.
export function flowHasPolicy(
  f: { src_workload: string; src_namespace: string; dst_workload: string; dst_namespace: string; dst_port: number },
  policies: NetworkPolicyInfo[],
): boolean {
  const srcWorkload = normalizeWorkload(f.src_workload)
  const dstAllows = policies.some(p => {
    if (p.namespace !== f.dst_namespace || p.dst_service !== f.dst_workload) return false
    const portMatches = p.dst_ports.some(ps => ps.port === f.dst_port) || p.dst_port === f.dst_port
    if (!portMatches) return false
    if (p.policy_type === 'allow') return p.src_workload === srcWorkload && p.src_namespace === f.src_namespace
    if (p.policy_type === 'allow-namespace') return p.src_namespace === f.src_namespace
    return false
  })
  if (!dstAllows) return false

  // The destination allowing ingress isn't enough — the source namespace
  // could have its own egress-deny blocking the packet before it ever
  // leaves, independent of anything the destination allows.
  const srcExplain = explainAccess(srcWorkload, f.src_namespace, 'egress', policies)
  if (!srcExplain.blocked) return true
  return isDestinationExempt(srcExplain.exceptions, f.dst_workload, f.src_namespace, f.dst_namespace)
}
