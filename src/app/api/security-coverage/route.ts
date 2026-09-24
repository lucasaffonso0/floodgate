import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { listServices, listNetworkPolicies, isolateNamespace } from '@/lib/k8s'
import { getConfig, isNamespaceWatched, getAutoDefaultDenyBaseline } from '@/lib/config'
import { logAudit } from '@/lib/audit'
import { getDb } from '@/lib/db'
import { trackIsolatedPolicies } from '@/lib/autosync'
import { getNamespaceIsolation } from '@/lib/nsIsolation'
import { getWriteMode } from '@/lib/writeMode'
import type { SecurityCoverage } from '@/types'

const SELF_NAMESPACE = 'floodgate'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })

  const [services, policies] = await Promise.all([listServices(), listNetworkPolicies()])
  const cfg = getConfig()

  const watched = services.filter(s => s.namespace !== SELF_NAMESPACE && isNamespaceWatched(s.namespace))
  const byNamespace = new Map<string, string[]>()
  for (const s of watched) {
    if (!byNamespace.has(s.namespace)) byNamespace.set(s.namespace, [])
    byNamespace.get(s.namespace)!.push(s.name)
  }

  // Don't apply auto-deny while policies are paused: cluster is intentionally empty
  const isPaused = (getDb().prepare('SELECT COUNT(*) as n FROM saved_policies').get() as { n: number }).n > 0

  // Namespaces present when scope was last switched to future_only: skip
  // auto-apply for them entirely (they're the "already existing" set).
  const baseline = cfg.auto_default_deny_scope === 'future_only' ? new Set(getAutoDefaultDenyBaseline()) : null

  const coverage: SecurityCoverage[] = []
  for (const [ns, svcs] of byNamespace) {
    const nsPolicies = policies.filter(p => p.namespace === ns)
    const managed_policy_count = nsPolicies.length

    // Namespace isolation, not per-service: same source of truth as the
    // graph's namespace panel and the Segurança tab, so all three agree.
    const { isolatedIn: has_deny_ingress, isolatedEg: has_deny_egress } = getNamespaceIsolation(ns, policies)
    const has_intra_ingress = nsPolicies.some(p => p.policy_type === 'allow-intranamespace' && p.policy_types.includes('Ingress'))
    const has_intra_egress  = nsPolicies.some(p => p.policy_type === 'allow-intranamespace' && p.policy_types.includes('Egress'))
    const has_internet_egress = nsPolicies.some(p => p.policy_type === 'allow-egress' && p.dst_service === 'internet')

    let applied_ingress = has_deny_ingress
    let applied_egress = has_deny_egress

    // Auto-apply only runs for admins: GET must stay side-effect-free for
    // read-only roles (viewer/audit), which the middleware does not block.
    // future_only scope: skip namespaces that were already around when that
    // mode was last turned on: coverage is still reported, just not touched.
    // Under GitOps, this automatic trigger is disabled entirely, since an
    // unconditional, unreviewed commit firing from inside a GET handler
    // doesn't fit GitOps's deliberate-change model.
    // Manual isolation (the Segurança tab's "Isolar" button) is unaffected:
    // it still calls isolateNamespace(), which already routes to git.
    if (cfg.auto_default_deny_enabled && !isPaused && user.role === 'admin' && !baseline?.has(ns) && getWriteMode() !== 'gitops') {
      const dir = cfg.auto_default_deny_direction
      const allowIntra = cfg.auto_default_deny_allow_intra
      const allowInternet = cfg.auto_default_deny_allow_internet
      // Re-run whenever the base deny OR any configured extra is still
      // missing: isolateNamespace() is idempotent per-policy (409 → skip),
      // so calling it again just fills in whatever's absent without
      // touching what's already there. Otherwise turning on "permitir
      // tráfego interno"/"internet" after a namespace was already denied
      // would never actually get applied to it.
      const needsIngress = (dir === 'ingress' || dir === 'both') && (!has_deny_ingress || (allowIntra && !has_intra_ingress))
      const needsEgress  = (dir === 'egress'  || dir === 'both') && (!has_deny_egress  || (allowIntra && !has_intra_egress) || (allowInternet && !has_internet_egress))
      if (needsIngress) {
        try {
          const result = await isolateNamespace({ namespace: ns, direction: 'ingress', allow_intra_namespace: allowIntra, allow_egress_internet: false })
          trackIsolatedPolicies(ns, 'ingress', allowIntra, false)
          logAudit({ username: 'system', action: 'auto_default_deny_ingress', resource_type: 'NetworkPolicy', resource_name: ns, namespace: ns, details: JSON.stringify(result) })
          applied_ingress = true
        } catch (e) { console.error(`[floodgate] auto default-deny ingress falhou para ${ns}:`, e) }
      }
      if (needsEgress) {
        try {
          const result = await isolateNamespace({ namespace: ns, direction: 'egress', allow_intra_namespace: allowIntra, allow_egress_internet: allowInternet })
          trackIsolatedPolicies(ns, 'egress', allowIntra, allowInternet)
          logAudit({ username: 'system', action: 'auto_default_deny_egress', resource_type: 'NetworkPolicy', resource_name: ns, namespace: ns, details: JSON.stringify(result) })
          applied_egress = true
        } catch (e) { console.error(`[floodgate] auto default-deny egress falhou para ${ns}:`, e) }
      }
    }

    coverage.push({ namespace: ns, service_count: svcs.length, has_deny_ingress: applied_ingress, has_deny_egress: applied_egress, managed_policy_count })
  }

  return NextResponse.json(coverage)
}
