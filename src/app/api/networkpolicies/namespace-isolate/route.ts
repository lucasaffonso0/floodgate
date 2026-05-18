import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser, canManageNamespace } from '@/lib/auth'
import { isolateNamespace, getPolicyYAML } from '@/lib/k8s'
import { logAudit } from '@/lib/audit'
import { saveManagedPolicy } from '@/lib/autosync'
import { emit } from '@/lib/sse'

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })

  const { namespace, direction, allow_intra_namespace, allow_egress_internet } = await req.json()

  if (!namespace || !direction) {
    return NextResponse.json({ detail: 'namespace e direction são obrigatórios' }, { status: 400 })
  }
  if (!['ingress', 'egress', 'both'].includes(direction)) {
    return NextResponse.json({ detail: "direction deve ser 'ingress', 'egress' ou 'both'" }, { status: 400 })
  }

  if (!await canManageNamespace(user.sub, user.role, namespace)) {
    return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })
  }

  const result = await isolateNamespace({ namespace, direction, allow_intra_namespace: !!allow_intra_namespace, allow_egress_internet: !!allow_egress_internet })

  // Save each created policy to managed_policies for autosync tracking
  const dirs: ('ingress' | 'egress')[] = direction === 'both' ? ['ingress', 'egress'] : [direction]
  for (const dir of dirs) {
    const names = [`floodgate-ns-deny-${dir}-${namespace}`.slice(0, 63)]
    if (allow_intra_namespace) names.push(`floodgate-intra-${dir}-${namespace}`.slice(0, 63))
    for (const n of names) {
      getPolicyYAML(namespace, n).then(y => saveManagedPolicy(namespace, n, y)).catch(() => {})
    }
  }
  if (allow_egress_internet && (direction === 'egress' || direction === 'both')) {
    const n = `floodgate-egress-internet-${namespace}`.slice(0, 63)
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
}
