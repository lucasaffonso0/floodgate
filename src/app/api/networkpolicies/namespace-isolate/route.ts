import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser, canManageNamespace } from '@/lib/auth'
import { isolateNamespace, getPolicyYAML, sanitizeK8sName } from '@/lib/k8s'
import { isNamespaceWatched } from '@/lib/config'
import { apiError, parseBody } from '@/lib/api-helpers'
import { logAudit } from '@/lib/audit'
import { saveManagedPolicy } from '@/lib/autosync'
import { emit } from '@/lib/sse'

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })

  const body = await parseBody<{ namespace?: string; direction?: string; allow_intra_namespace?: boolean; allow_egress_internet?: boolean }>(req)
  if (!body) return NextResponse.json({ detail: 'Body JSON inválido' }, { status: 400 })
  const { namespace, direction, allow_intra_namespace, allow_egress_internet } = body

  if (!namespace || !direction) {
    return NextResponse.json({ detail: 'namespace e direction são obrigatórios' }, { status: 400 })
  }
  if (!['ingress', 'egress', 'both'].includes(direction)) {
    return NextResponse.json({ detail: "direction deve ser 'ingress', 'egress' ou 'both'" }, { status: 400 })
  }

  if (!isNamespaceWatched(namespace)) {
    return NextResponse.json({ detail: 'Namespace fora do escopo gerenciado pelo floodgate' }, { status: 400 })
  }
  if (!await canManageNamespace(user.sub, user.role, namespace)) {
    return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })
  }

  try {
    const result = await isolateNamespace({
      namespace,
      direction: direction as 'ingress' | 'egress' | 'both',
      allow_intra_namespace: !!allow_intra_namespace,
      allow_egress_internet: !!allow_egress_internet,
    })

    // Save each created policy to managed_policies for autosync tracking.
    // Names must be built exactly like isolateNamespace does (sanitizeK8sName).
    const dirs: ('ingress' | 'egress')[] = direction === 'both' ? ['ingress', 'egress'] : [direction as 'ingress' | 'egress']
    for (const dir of dirs) {
      const names = [sanitizeK8sName(`floodgate-ns-deny-${dir}-${namespace}`)]
      if (allow_intra_namespace) names.push(sanitizeK8sName(`floodgate-intra-${dir}-${namespace}`))
      for (const n of names) {
        getPolicyYAML(namespace, n).then(y => saveManagedPolicy(namespace, n, y)).catch(() => {})
      }
    }
    if (allow_egress_internet && (direction === 'egress' || direction === 'both')) {
      const n = sanitizeK8sName(`floodgate-egress-internet-${namespace}`)
      getPolicyYAML(namespace, n).then(y => saveManagedPolicy(namespace, n, y)).catch(() => {})
    }

    logAudit({
      user_id: user.sub,
      username: user.username,
      action: 'namespace_isolate',
      resource_type: 'NetworkPolicy',
      resource_name: namespace,
      namespace,
      details: JSON.stringify({ direction, allow_intra_namespace, allow_egress_internet, ...result }),
    })

    emit({ type: 'policy_created' })
    return NextResponse.json(result, { status: 201 })
  } catch (e) {
    return apiError(e, 'Falha ao isolar namespace')
  }
}
