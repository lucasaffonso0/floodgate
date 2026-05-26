import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser, canManageNamespace } from '@/lib/auth'
import { createCidrPolicy, getPolicyYAML } from '@/lib/k8s'
import { logAudit } from '@/lib/audit'
import { saveManagedPolicy } from '@/lib/autosync'
import { emit } from '@/lib/sse'

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })

  const body = await req.json()
  const { namespace, cidr, direction } = body

  if (!namespace || !cidr || !direction)
    return NextResponse.json({ detail: 'namespace, cidr e direction são obrigatórios' }, { status: 400 })
  if (!['ingress', 'egress'].includes(direction))
    return NextResponse.json({ detail: "direction deve ser 'ingress' ou 'egress'" }, { status: 400 })
  if (!/^[\d.a-fA-F:]+\/\d{1,3}$/.test(cidr.trim()))
    return NextResponse.json({ detail: 'CIDR inválido (ex: 10.0.0.0/8)' }, { status: 400 })
  if (!await canManageNamespace(user.sub, user.role, namespace))
    return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })

  let result
  try {
    result = await createCidrPolicy(body)
  } catch (e: unknown) {
    if ((e as { statusCode?: number }).statusCode === 404)
      return NextResponse.json({ detail: `Service '${body.service_name}' not found in namespace '${namespace}'` }, { status: 400 })
    throw e
  }
  getPolicyYAML(result.namespace, result.name).then(y => saveManagedPolicy(result.namespace, result.name, y)).catch(() => {})
  logAudit({
    user_id: user.sub, username: user.username,
    action: 'cidr_policy_create', resource_type: 'NetworkPolicy',
    resource_name: result.name, namespace,
    details: JSON.stringify({ cidr, direction, service_name: body.service_name }),
  })
  emit({ type: 'policy_created' })
  return NextResponse.json(result, { status: 201 })
}
