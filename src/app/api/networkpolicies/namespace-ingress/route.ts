import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser, canManageNamespace } from '@/lib/auth'
import { createNamespaceIngressPolicy, getPolicyYAML } from '@/lib/k8s'
import { logAudit } from '@/lib/audit'
import { saveManagedPolicy } from '@/lib/autosync'
import { emit } from '@/lib/sse'

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })

    const body = await req.json()
    const { src_namespace, dst_service, dst_namespace, dst_port } = body
    if (!src_namespace || !dst_service || !dst_namespace || !dst_port) {
      return NextResponse.json({ detail: 'Campos obrigatórios: src_namespace, dst_service, dst_namespace, dst_port' }, { status: 400 })
    }

    if (!(await canManageNamespace(user.sub, user.role, dst_namespace))) {
      return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })
    }

    const result = await createNamespaceIngressPolicy({ src_namespace, dst_service, dst_namespace, dst_port })
    logAudit({
      user_id: user.sub, username: user.username,
      action: 'create_namespace_ingress_policy',
      resource_type: 'NetworkPolicy', resource_name: result.name, namespace: dst_namespace,
      details: `src_namespace=${src_namespace}`,
    })
    getPolicyYAML(result.namespace, result.name).then(y => saveManagedPolicy(result.namespace, result.name, y)).catch(() => {})
    emit({ type: 'policy_created' })
    return NextResponse.json(result, { status: 201 })
  } catch (e) {
    return NextResponse.json({ detail: String(e) }, { status: 500 })
  }
}
