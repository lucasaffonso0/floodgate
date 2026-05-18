import { NextRequest, NextResponse } from 'next/server'
import { listNetworkPolicies, createNetworkPolicy, getPolicyYAML } from '@/lib/k8s'
import { getCurrentUser, canManageNamespace } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { saveManagedPolicy } from '@/lib/autosync'
import { emit } from '@/lib/sse'

export async function GET(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })
  try {
    const all = req.nextUrl.searchParams.get('all') === 'true'
    return NextResponse.json(await listNetworkPolicies(all))
  } catch (e) {
    return NextResponse.json({ detail: String(e) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })
    const raw = await req.json()
    const body = raw.dst_port !== undefined && raw.dst_ports === undefined
      ? { ...raw, dst_ports: [{ port: raw.dst_port, protocol: 'TCP' as const }] }
      : raw
    if (!body.dst_namespace || !body.src_namespace || !body.dst_service) {
      return NextResponse.json({ detail: 'dst_namespace, src_namespace e dst_service são obrigatórios' }, { status: 400 })
    }
    if (!(await canManageNamespace(user.sub, user.role, body.dst_namespace))) {
      return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })
    }
    const result = await createNetworkPolicy(body)
    logAudit({ user_id: user.sub, username: user.username, action: 'create_policy', resource_type: 'NetworkPolicy', resource_name: result.name, namespace: result.namespace })
    getPolicyYAML(result.namespace, result.name).then(y => saveManagedPolicy(result.namespace, result.name, y)).catch(() => {})
    emit({ type: 'policy_created' })
    return NextResponse.json(result, { status: 201 })
  } catch (e) {
    return NextResponse.json({ detail: String(e) }, { status: 500 })
  }
}
