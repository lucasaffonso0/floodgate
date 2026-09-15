import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser, canManageNamespace } from '@/lib/auth'
import { createCidrPolicy, getPolicyYAML } from '@/lib/k8s'
import { isNamespaceWatched } from '@/lib/config'
import { apiError, parseBody, invalidPortsMessage } from '@/lib/api-helpers'
import { logAudit } from '@/lib/audit'
import { saveManagedPolicy } from '@/lib/autosync'
import { emit } from '@/lib/sse'

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })

  const body = await parseBody<Record<string, unknown>>(req)
  if (!body) return NextResponse.json({ detail: 'Body JSON inválido' }, { status: 400 })
  const { namespace, cidr, direction } = body as { namespace?: string; cidr?: string; direction?: string }

  if (!namespace || !cidr || !direction)
    return NextResponse.json({ detail: 'namespace, cidr e direction são obrigatórios' }, { status: 400 })
  if (!['ingress', 'egress'].includes(direction))
    return NextResponse.json({ detail: "direction deve ser 'ingress' ou 'egress'" }, { status: 400 })
  const CIDR_RE = /^[\d.a-fA-F:]+\/\d{1,3}$/
  if (!CIDR_RE.test(cidr.trim()))
    return NextResponse.json({ detail: 'CIDR inválido (ex: 10.0.0.0/8)' }, { status: 400 })
  if (body.except !== undefined) {
    if (!Array.isArray(body.except)) {
      return NextResponse.json({ detail: "'except' deve ser um array de CIDRs" }, { status: 400 })
    }
    const invalid = (body.except as unknown[]).find(e => typeof e !== 'string' || !CIDR_RE.test((e as string).trim()))
    if (invalid !== undefined) {
      return NextResponse.json({ detail: `CIDR inválido em 'except': ${invalid}` }, { status: 400 })
    }
  }
  const portsError = invalidPortsMessage(body.dst_ports)
  if (portsError) return NextResponse.json({ detail: portsError }, { status: 400 })
  if (!isNamespaceWatched(namespace))
    return NextResponse.json({ detail: 'Namespace fora do escopo gerenciado pelo floodgate' }, { status: 400 })
  if (!await canManageNamespace(user.sub, user.role, namespace))
    return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })

  let result
  try {
    result = await createCidrPolicy(body as unknown as Parameters<typeof createCidrPolicy>[0])
  } catch (e: unknown) {
    if ((e as { statusCode?: number }).statusCode === 404)
      return NextResponse.json({ detail: `Service '${body.service_name}' not found in namespace '${namespace}'` }, { status: 400 })
    return apiError(e, 'Falha ao criar policy CIDR')
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
