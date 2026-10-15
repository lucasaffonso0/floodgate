import 'server-only'
import { listServices, listNetworkPolicies, isolateNamespace } from './k8s'
import { getConfig, namespaceWatchFilter, getAutoDefaultDenyBaseline } from './config'
import { logAudit } from './audit'
import { getDb } from './db'
import { trackIsolatedPolicies } from './autosync'
import { getNamespaceIsolation } from './nsIsolation'
import { getWriteMode } from './writeMode'
import type { NetworkPolicyInfo, ServiceInfo, SecurityCoverage } from '@/types'

const SELF_NAMESPACE = 'floodgate'

function watchedByNamespace(services: ServiceInfo[]): Map<string, string[]> {
  const byNamespace = new Map<string, string[]>()
  const watched = namespaceWatchFilter()
  for (const s of services) {
    if (s.namespace === SELF_NAMESPACE || !watched(s.namespace)) continue
    if (!byNamespace.has(s.namespace)) byNamespace.set(s.namespace, [])
    byNamespace.get(s.namespace)!.push(s.name)
  }
  return byNamespace
}

// Per-namespace isolation posture, read-only. Namespace isolation, not
// per-service: same source of truth (getNamespaceIsolation) as the graph's
// namespace panel and the Segurança tab, so all three agree.
export function computeSecurityCoverage(services: ServiceInfo[], policies: NetworkPolicyInfo[]): SecurityCoverage[] {
  const coverage: SecurityCoverage[] = []
  for (const [ns, svcs] of watchedByNamespace(services)) {
    const { isolatedIn, isolatedEg } = getNamespaceIsolation(ns, policies)
    coverage.push({
      namespace: ns,
      service_count: svcs.length,
      has_deny_ingress: isolatedIn,
      has_deny_egress: isolatedEg,
      managed_policy_count: policies.filter(p => p.namespace === ns).length,
    })
  }
  return coverage
}

// Applies the configured default-deny to every watched namespace still
// missing it. Runs from the scheduler every tick, so it no longer depends on
// an admin having the page open (it used to run inside GET
// /api/security-coverage, triggered by the browser's poll). Same rules as
// before:
// - off while policies are paused (the cluster is intentionally empty);
// - off under GitOps (an unreviewed commit firing on a timer doesn't fit
//   GitOps's deliberate-change model; manual isolation still works there);
// - future_only scope: namespaces in the baseline (present when that mode
//   was turned on) are never touched;
// - idempotent: isolateNamespace() skips what already exists (409), so it
//   only fills in what's missing, including an extra (intra/internet)
//   turned on after a namespace was already denied;
// - audited as 'system'.
export async function runAutoDefaultDeny(): Promise<void> {
  const cfg = getConfig()
  if (!cfg.auto_default_deny_enabled || getWriteMode() === 'gitops') return
  const isPaused = (getDb().prepare('SELECT COUNT(*) as n FROM saved_policies').get() as { n: number }).n > 0
  if (isPaused) return

  const [services, policies] = await Promise.all([listServices(), listNetworkPolicies()])
  const baseline = cfg.auto_default_deny_scope === 'future_only' ? new Set(getAutoDefaultDenyBaseline()) : null
  const dir = cfg.auto_default_deny_direction
  const allowIntra = cfg.auto_default_deny_allow_intra
  const allowInternet = cfg.auto_default_deny_allow_internet

  for (const ns of watchedByNamespace(services).keys()) {
    if (baseline?.has(ns)) continue
    const nsPolicies = policies.filter(p => p.namespace === ns)
    const { isolatedIn, isolatedEg } = getNamespaceIsolation(ns, policies)
    const hasIntraIngress = nsPolicies.some(p => p.policy_type === 'allow-intranamespace' && p.policy_types.includes('Ingress'))
    const hasIntraEgress = nsPolicies.some(p => p.policy_type === 'allow-intranamespace' && p.policy_types.includes('Egress'))
    const hasInternetEgress = nsPolicies.some(p => p.policy_type === 'allow-egress' && p.dst_service === 'internet')

    const needsIngress = (dir === 'ingress' || dir === 'both') && (!isolatedIn || (allowIntra && !hasIntraIngress))
    const needsEgress = (dir === 'egress' || dir === 'both') && (!isolatedEg || (allowIntra && !hasIntraEgress) || (allowInternet && !hasInternetEgress))
    if (needsIngress) {
      try {
        const result = await isolateNamespace({ namespace: ns, direction: 'ingress', allow_intra_namespace: allowIntra, allow_egress_internet: false })
        trackIsolatedPolicies(ns, 'ingress', allowIntra, false)
        logAudit({ username: 'system', action: 'auto_default_deny_ingress', resource_type: 'NetworkPolicy', resource_name: ns, namespace: ns, details: JSON.stringify(result) })
      } catch (e) { console.error(`[floodgate] auto default-deny ingress falhou para ${ns}:`, e) }
    }
    if (needsEgress) {
      try {
        const result = await isolateNamespace({ namespace: ns, direction: 'egress', allow_intra_namespace: allowIntra, allow_egress_internet: allowInternet })
        trackIsolatedPolicies(ns, 'egress', allowIntra, allowInternet)
        logAudit({ username: 'system', action: 'auto_default_deny_egress', resource_type: 'NetworkPolicy', resource_name: ns, namespace: ns, details: JSON.stringify(result) })
      } catch (e) { console.error(`[floodgate] auto default-deny egress falhou para ${ns}:`, e) }
    }
  }
}
