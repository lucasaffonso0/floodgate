import { NextRequest, NextResponse } from 'next/server'
import { createRestrictPolicy, getPolicyYAML } from '@/lib/k8s'
import { getCurrentUser, canManageNamespace } from '@/lib/auth'
import { isNamespaceWatched } from '@/lib/config'
import { apiError, parseBody } from '@/lib/api-helpers'
import { logAudit } from '@/lib/audit'
import { saveManagedPolicy } from '@/lib/autosync'
import { emit } from '@/lib/sse'

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })
  const body = await parseBody(req)
  if (!body) return NextResponse.json({ detail: 'Body JSON inválido' }, { status: 400 })
  if (!body.namespace) {
    return NextResponse.json({ detail: 'namespace é obrigatório' }, { status: 400 })
  }
  if (!['ingress', 'egress'].includes(body.direction as string)) {
    return NextResponse.json({ detail: "direction deve ser 'ingress' ou 'egress'" }, { status: 400 })
  }
  if (!isNamespaceWatched(body.namespace as string)) {
    return NextResponse.json({ detail: 'Namespace fora do escopo gerenciado pelo floodgate' }, { status: 400 })
  }
  if (!(await canManageNamespace(user.sub, user.role, body.namespace as string))) {
    return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })
  }
  try {
    const result = await createRestrictPolicy(body as unknown as Parameters<typeof createRestrictPolicy>[0])
    logAudit({ user_id: user.sub, username: user.username, action: 'create_policy', resource_type: 'NetworkPolicy', resource_name: result.name, namespace: result.namespace })
    getPolicyYAML(result.namespace, result.name).then(y => saveManagedPolicy(result.namespace, result.name, y)).catch(() => {})
    emit({ type: 'policy_created' })
    return NextResponse.json(result, { status: 201 })
  } catch (e) {
    return apiError(e, 'Falha ao criar policy de restrição')
  }
}
