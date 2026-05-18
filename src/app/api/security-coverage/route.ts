import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { listServices, listNetworkPolicies, createRestrictPolicy, getPolicyYAML } from '@/lib/k8s'
import { getConfig, isNamespaceWatched } from '@/lib/config'
import { logAudit } from '@/lib/audit'
import { getDb } from '@/lib/db'
import { saveManagedPolicy } from '@/lib/autosync'
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

  // Don't apply auto-deny while policies are paused — cluster is intentionally empty
  const isPaused = (getDb().prepare('SELECT COUNT(*) as n FROM saved_policies').get() as { n: number }).n > 0

  const coverage: SecurityCoverage[] = []
  for (const [ns, svcs] of byNamespace) {
    const nsPolicies = policies.filter(p => p.namespace === ns)
    const has_deny_ingress = nsPolicies.some(p => p.policy_type === 'restrict-ingress')
    const has_deny_egress  = nsPolicies.some(p => p.policy_type === 'restrict-egress')
    const managed_policy_count = nsPolicies.length

    let applied_ingress = has_deny_ingress
    let applied_egress = has_deny_egress

    if (cfg.auto_default_deny_enabled && !isPaused) {
      const dir = cfg.auto_default_deny_direction
      if ((dir === 'ingress' || dir === 'both') && !has_deny_ingress) {
        const noDenyServices = svcs.filter(name => !nsPolicies.some(p => p.dst_service === name && p.policy_type === 'restrict-ingress'))
        for (const svc of noDenyServices) {
          try {
            const p = await createRestrictPolicy({ service_name: svc, namespace: ns, direction: 'ingress' })
            logAudit({ username: 'system', action: 'auto_default_deny_ingress', resource_type: 'NetworkPolicy', resource_name: svc, namespace: ns })
            getPolicyYAML(p.namespace, p.name).then(y => saveManagedPolicy(p.namespace, p.name, y)).catch(() => {})
            applied_ingress = true
          } catch { /* policy may already exist */ }
        }
      }
      if ((dir === 'egress' || dir === 'both') && !has_deny_egress) {
        const noDenyServices = svcs.filter(name => !nsPolicies.some(p => p.dst_service === name && p.policy_type === 'restrict-egress'))
        for (const svc of noDenyServices) {
          try {
            const p = await createRestrictPolicy({ service_name: svc, namespace: ns, direction: 'egress' })
            logAudit({ username: 'system', action: 'auto_default_deny_egress', resource_type: 'NetworkPolicy', resource_name: svc, namespace: ns })
            getPolicyYAML(p.namespace, p.name).then(y => saveManagedPolicy(p.namespace, p.name, y)).catch(() => {})
            applied_egress = true
          } catch { /* policy may already exist */ }
        }
      }
    }

    coverage.push({ namespace: ns, service_count: svcs.length, has_deny_ingress: applied_ingress, has_deny_egress: applied_egress, managed_policy_count })
  }

  return NextResponse.json(coverage)
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user || user.role !== 'admin') return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })

  const { namespace, direction } = await req.json()
  if (!namespace || !direction) return NextResponse.json({ detail: 'namespace e direction são obrigatórios' }, { status: 400 })
  if (!['ingress', 'egress', 'both'].includes(direction)) return NextResponse.json({ detail: "direction deve ser 'ingress', 'egress' ou 'both'" }, { status: 400 })
  const services = await listServices()
  const nsSvcs = services.filter(s => s.namespace === namespace)

  const results = []
  for (const svc of nsSvcs) {
    if (direction === 'ingress' || direction === 'both') {
      const p = await createRestrictPolicy({ service_name: svc.name, namespace, direction: 'ingress' })
      results.push(p)
      logAudit({ user_id: user.sub, username: user.username, action: 'apply_default_deny_ingress', resource_type: 'NetworkPolicy', resource_name: svc.name, namespace })
      getPolicyYAML(p.namespace, p.name).then(y => saveManagedPolicy(p.namespace, p.name, y)).catch(() => {})
    }
    if (direction === 'egress' || direction === 'both') {
      const p = await createRestrictPolicy({ service_name: svc.name, namespace, direction: 'egress' })
      results.push(p)
      logAudit({ user_id: user.sub, username: user.username, action: 'apply_default_deny_egress', resource_type: 'NetworkPolicy', resource_name: svc.name, namespace })
      getPolicyYAML(p.namespace, p.name).then(y => saveManagedPolicy(p.namespace, p.name, y)).catch(() => {})
    }
  }
  return NextResponse.json(results, { status: 201 })
}
