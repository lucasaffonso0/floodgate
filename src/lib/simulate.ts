import type { NetworkPolicyInfo, Draft, CiliumFlowSummary } from '@/types'
import { explainAccess, sourceIsExempt, isDestinationExempt } from './explainAccess'
import { normalizeWorkload } from './flowMatch'

let seq = 0
function fabricated(overrides: Partial<NetworkPolicyInfo>): NetworkPolicyInfo {
  return {
    name: `__draft_${seq++}__`,
    namespace: '', src_workload: '', src_namespace: '', dst_service: '',
    dst_port: 0, dst_ports: [], policy_type: 'allow', managed: true,
    policy_types: [], pod_selector: {}, ingress_count: 0, egress_count: 0,
    ...overrides,
  }
}

// Same reasoning FlowExplainPanel uses (NetworkGraph.tsx) to decide whether
// a flow is actually blocked, extracted so both stay in sync instead of
// drifting apart again like ingress/egress did earlier this session.
export function isFlowBlocked(
  f: { src_workload: string; src_namespace: string; dst_workload: string; dst_namespace: string },
  policies: NetworkPolicyInfo[],
): boolean {
  const srcW = normalizeWorkload(f.src_workload)
  const dstW = normalizeWorkload(f.dst_workload)

  const dstExplain = explainAccess(dstW, f.dst_namespace, 'ingress', policies)
  const exemptAtDst = !dstExplain.blocked || sourceIsExempt(dstExplain.exceptions, f.src_namespace, srcW, f.dst_namespace)
  if (!exemptAtDst) return true

  const srcExplain = explainAccess(srcW, f.src_namespace, 'egress', policies)
  const exemptAtSrc = !srcExplain.blocked || isDestinationExempt(srcExplain.exceptions, dstW, f.src_namespace, f.dst_namespace)
  return !exemptAtSrc
}

// The NetworkPolicy objects a draft *would* create if applied — mirrors
// k8s.ts's createNetworkPolicy()/createEgressNetworkPolicy()/
// createCidrPolicy()/isolateNamespace()/restrictService(), but only builds
// the plain objects in memory. No Kubernetes API call, nothing persisted.
export function draftToPolicies(draft: Draft): NetworkPolicyInfo[] {
  if (draft.kind === 'isolate') {
    const ns = draft.isolate_namespace!
    const dir = draft.isolate_direction!
    const directions: Array<'ingress' | 'egress'> = dir === 'both' ? ['ingress', 'egress'] : [dir]
    const out: NetworkPolicyInfo[] = []
    for (const d of directions) {
      out.push(fabricated({
        namespace: ns, dst_service: '',
        policy_type: d === 'ingress' ? 'restrict-ingress' : 'restrict-egress',
        policy_types: [d === 'ingress' ? 'Ingress' : 'Egress'],
      }))
      if (draft.isolate_allow_intra) {
        out.push(fabricated({ namespace: ns, policy_type: 'allow-intranamespace', policy_types: [d === 'ingress' ? 'Ingress' : 'Egress'] }))
      }
      if (d === 'egress' && draft.isolate_allow_internet) {
        out.push(fabricated({ namespace: ns, src_workload: '', src_namespace: ns, dst_service: 'internet', policy_type: 'allow-egress', policy_types: ['Egress'] }))
      }
    }
    return out
  }

  if (draft.kind === 'restrict') {
    return [fabricated({
      namespace: draft.restrict_namespace!, dst_service: draft.restrict_service!,
      policy_type: draft.restrict_direction === 'ingress' ? 'restrict-ingress' : 'restrict-egress',
      policy_types: [draft.restrict_direction === 'ingress' ? 'Ingress' : 'Egress'],
    })]
  }

  // 'toggle': liga/desliga o companion de um isolamento JÁ real. 'disable'
  // não fabrica nada aqui — a remoção é modelada como exclusão da policy
  // real correspondente em computeEffectivePolicies(), não como uma policy
  // fabricada a mais.
  if (draft.kind === 'toggle') {
    if (draft.toggle_action !== 'enable') return []
    if (draft.toggle_option === 'intra') {
      return (draft.toggle_directions ?? ['ingress', 'egress']).map(dir => fabricated({
        namespace: draft.toggle_namespace!, policy_type: 'allow-intranamespace',
        policy_types: [dir === 'ingress' ? 'Ingress' : 'Egress'],
      }))
    }
    return [fabricated({
      namespace: draft.toggle_namespace!, src_workload: '', src_namespace: draft.toggle_namespace!,
      dst_service: 'internet', policy_type: 'allow-egress', policy_types: ['Egress'],
    })]
  }

  // 'connection' (allow/egress/CIDR) — the kind every draft used to be.
  const out: NetworkPolicyInfo[] = []
  const isCidr = !!draft.src_cidr || !!draft.dst_cidr
  const wantsIngress = draft.policy_direction === 'ingress' || draft.policy_direction === 'both'
  const wantsEgress = draft.policy_direction === 'egress' || draft.policy_direction === 'both'

  if (isCidr) {
    if (draft.src_cidr) {
      out.push(fabricated({
        namespace: draft.dst_namespace, dst_service: draft.dst_service, dst_port: draft.dst_ports[0]?.port ?? 0,
        dst_ports: draft.dst_ports, policy_type: 'cidr-ingress', policy_types: ['Ingress'],
      }))
    }
    if (draft.dst_cidr) {
      out.push(fabricated({
        namespace: draft.src_namespace, dst_service: draft.dst_service, dst_port: draft.dst_ports[0]?.port ?? 0,
        dst_ports: draft.dst_ports, policy_type: 'cidr-egress', policy_types: ['Egress'],
      }))
    }
    return out
  }

  if (wantsIngress) {
    out.push(fabricated({
      namespace: draft.dst_namespace, dst_service: draft.dst_service,
      src_workload: normalizeWorkload(draft.src_workload), src_namespace: draft.src_namespace,
      dst_port: draft.dst_ports[0]?.port ?? 0, dst_ports: draft.dst_ports,
      policy_type: 'allow', policy_types: ['Ingress'],
    }))
  }
  if (wantsEgress) {
    out.push(fabricated({
      namespace: draft.src_namespace, dst_service: draft.dst_service,
      src_workload: normalizeWorkload(draft.src_workload), src_namespace: draft.src_namespace,
      dst_port: draft.dst_ports[0]?.port ?? 0, dst_ports: draft.dst_ports,
      policy_type: 'allow-egress', policy_types: ['Egress'],
    }))
  }
  return out
}

function matchesToggleTarget(p: NetworkPolicyInfo, d: Draft): boolean {
  if (d.kind !== 'toggle' || d.toggle_action !== 'disable') return false
  if (p.namespace !== d.toggle_namespace) return false
  if (d.toggle_option === 'intra') return p.policy_type === 'allow-intranamespace'
  return p.policy_type === 'allow-egress' && p.dst_service === 'internet'
}

// The single "real + drafts" view every consumer (graph preview, Descoberta,
// impact banner, panel status) should render against. Additive for every
// draft kind except 'toggle'+'disable', which instead EXCLUDES the matching
// real companion policy — the one case where a draft's effect is "this real
// policy stops existing" rather than "this new policy gets added".
export function computeEffectivePolicies(realPolicies: NetworkPolicyInfo[], drafts: Draft[]): NetworkPolicyInfo[] {
  const disableDrafts = drafts.filter(d => d.kind === 'toggle' && d.toggle_action === 'disable')
  const base = disableDrafts.length === 0
    ? realPolicies
    : realPolicies.filter(p => !disableDrafts.some(d => matchesToggleTarget(p, d)))
  return [...base, ...drafts.flatMap(draftToPolicies)]
}

// Compares "real policies" against "real policies + what these drafts
// would create", against real observed traffic (Descoberta) — which flows
// that work today would start failing, and which ones that fail today
// would start working, if every current draft got applied.
export function simulateImpact(
  flows: CiliumFlowSummary[],
  realPolicies: NetworkPolicyInfo[],
  drafts: Draft[],
): { breaking: CiliumFlowSummary[]; fixed: CiliumFlowSummary[] } {
  const hypothetical = computeEffectivePolicies(realPolicies, drafts)
  const breaking: CiliumFlowSummary[] = []
  const fixed: CiliumFlowSummary[] = []
  for (const f of flows) {
    const was = isFlowBlocked(f, realPolicies)
    const will = isFlowBlocked(f, hypothetical)
    if (!was && will) breaking.push(f)
    else if (was && !will) fixed.push(f)
  }
  return { breaking, fixed }
}
