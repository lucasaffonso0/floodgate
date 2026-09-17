import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { listServices, listNetworkPolicies, createNamespaceRestrictPolicy, isolateNamespace, getPolicyYAML } from '@/lib/k8s'
import { getConfig, isNamespaceWatched, getAutoDefaultDenyBaseline } from '@/lib/config'
import { parseBody } from '@/lib/api-helpers'
import { logAudit } from '@/lib/audit'
import { getDb } from '@/lib/db'
import { saveManagedPolicy, trackIsolatedPolicies } from '@/lib/autosync'
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

  // Namespaces present when scope was last switched to future_only — skip
  // auto-apply for them entirely (they're the "already existing" set).
  const baseline = cfg.auto_default_deny_scope === 'future_only' ? new Set(getAutoDefaultDenyBaseline()) : null

  const coverage: SecurityCoverage[] = []
  for (const [ns, svcs] of byNamespace) {
    const nsPolicies = policies.filter(p => p.namespace === ns)
    const has_deny_ingress = nsPolicies.some(p => p.policy_type === 'restrict-ingress')
    const has_deny_egress  = nsPolicies.some(p => p.policy_type === 'restrict-egress')
    const has_intra_ingress = nsPolicies.some(p => p.policy_type === 'allow-intranamespace' && p.policy_types.includes('Ingress'))
    const has_intra_egress  = nsPolicies.some(p => p.policy_type === 'allow-intranamespace' && p.policy_types.includes('Egress'))
    const has_internet_egress = nsPolicies.some(p => p.policy_type === 'allow-egress' && p.dst_service === 'internet')
    const managed_policy_count = nsPolicies.length

    let applied_ingress = has_deny_ingress
    let applied_egress = has_deny_egress

    // Auto-apply only runs for admins: GET must stay side-effect-free for
    // read-only roles (viewer/audit), which the middleware does not block.
    // future_only scope: skip namespaces that were already around when that
    // mode was last turned on — coverage is still reported, just not touched.
    if (cfg.auto_default_deny_enabled && !isPaused && user.role === 'admin' && !baseline?.has(ns)) {
      const dir = cfg.auto_default_deny_direction
      const allowIntra = cfg.auto_default_deny_allow_intra
      const allowInternet = cfg.auto_default_deny_allow_internet
      // Re-run whenever the base deny OR any configured extra is still
      // missing — isolateNamespace() is idempotent per-policy (409 → skip),
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

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user || user.role !== 'admin') return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })

  const body = await parseBody<{ namespace?: string; direction?: string }>(req)
  if (!body) return NextResponse.json({ detail: 'Body JSON inválido' }, { status: 400 })
  const { namespace, direction } = body
  if (!namespace || !direction) return NextResponse.json({ detail: 'namespace e direction são obrigatórios' }, { status: 400 })
  if (!['ingress', 'egress', 'both'].includes(direction)) return NextResponse.json({ detail: "direction deve ser 'ingress', 'egress' ou 'both'" }, { status: 400 })
  const results = []
  const errors: string[] = []
  const dirs = direction === 'both' ? ['ingress', 'egress'] as const : [direction as 'ingress' | 'egress']
  for (const dir of dirs) {
    try {
      const p = await createNamespaceRestrictPolicy(namespace, dir)
      results.push(p)
      logAudit({ user_id: user.sub, username: user.username, action: `apply_default_deny_${dir}`, resource_type: 'NetworkPolicy', resource_name: p.name, namespace })
      getPolicyYAML(p.namespace, p.name).then(y => saveManagedPolicy(p.namespace, p.name, y)).catch(() => {})
    } catch (e) {
      console.error(`[floodgate] default-deny ${dir} falhou para ${namespace}:`, e)
      errors.push(dir)
    }
  }
  if (errors.length > 0) {
    return NextResponse.json({ detail: `Falha ao aplicar default-deny (${errors.join(', ')})` }, { status: 500 })
  }
  return NextResponse.json(results, { status: 201 })
}
