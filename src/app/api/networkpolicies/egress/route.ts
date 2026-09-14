import { NextRequest, NextResponse } from 'next/server'
import { createEgressNetworkPolicy, getPolicyYAML } from '@/lib/k8s'
import { getCurrentUser, canManageNamespace } from '@/lib/auth'
import { isNamespaceWatched } from '@/lib/config'
import { apiError, parseBody } from '@/lib/api-helpers'
import { logAudit } from '@/lib/audit'
import { saveManagedPolicy } from '@/lib/autosync'
import { emit } from '@/lib/sse'

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })
  const raw = await parseBody(req)
  if (!raw) return NextResponse.json({ detail: 'Body JSON inválido' }, { status: 400 })
  const body = raw.dst_port !== undefined && raw.dst_ports === undefined
    ? { ...raw, dst_ports: [{ port: raw.dst_port, protocol: 'TCP' as const }] }
    : raw
  if (!body.dst_namespace || !body.src_namespace || !body.dst_service) {
    return NextResponse.json({ detail: 'dst_namespace, src_namespace e dst_service são obrigatórios' }, { status: 400 })
  }
  // Egress policy is created in src_namespace
  if (!isNamespaceWatched(body.src_namespace as string)) {
    return NextResponse.json({ detail: 'Namespace fora do escopo gerenciado pelo floodgate' }, { status: 400 })
  }
  if (!(await canManageNamespace(user.sub, user.role, body.src_namespace as string))) {
    return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })
  }
  try {
    const result = await createEgressNetworkPolicy(body as unknown as Parameters<typeof createEgressNetworkPolicy>[0])
    logAudit({ user_id: user.sub, username: user.username, action: 'create_policy', resource_type: 'NetworkPolicy', resource_name: result.name, namespace: result.namespace })
    getPolicyYAML(result.namespace, result.name).then(y => saveManagedPolicy(result.namespace, result.name, y)).catch(() => {})
    emit({ type: 'policy_created' })
    return NextResponse.json(result, { status: 201 })
  } catch (e) {
    return apiError(e, 'Falha ao criar policy egress')
  }
}
