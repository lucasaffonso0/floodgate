import { NextRequest, NextResponse } from 'next/server'
import { deleteNetworkPolicy, patchNetworkPolicyPort, getPolicyYAML } from '@/lib/k8s'
import { getCurrentUser, canManageNamespace } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { removeManagedPolicy, saveManagedPolicy } from '@/lib/autosync'
import { emit } from '@/lib/sse'

type Params = { params: Promise<{ ns: string; name: string }> }

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { ns, name } = await params
    const yamlStr = await getPolicyYAML(ns, name)
    return new NextResponse(yamlStr, { headers: { 'Content-Type': 'text/yaml' } })
  } catch (e) {
    return NextResponse.json({ detail: String(e) }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const { ns, name } = await params
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })
    if (!(await canManageNamespace(user.sub, user.role, ns))) {
      return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })
    }
    await deleteNetworkPolicy(ns, name)
    removeManagedPolicy(ns, name)
    logAudit({ user_id: user.sub, username: user.username, action: 'delete_policy', resource_type: 'NetworkPolicy', resource_name: name, namespace: ns })
    emit({ type: 'policy_deleted' })
    return new NextResponse(null, { status: 204 })
  } catch (e) {
    return NextResponse.json({ detail: String(e) }, { status: 500 })
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const { ns, name } = await params
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })
    if (!(await canManageNamespace(user.sub, user.role, ns))) {
      return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })
    }
    const body = await req.json()
    const dst_ports: Array<{ port: number; protocol: 'TCP' | 'UDP' | 'SCTP' }> =
      body.dst_ports ?? (body.dst_port ? [{ port: body.dst_port, protocol: 'TCP' as const }] : [])
    if (dst_ports.length === 0) {
      return NextResponse.json({ detail: 'dst_ports obrigatório' }, { status: 400 })
    }
    if (dst_ports.some(p => !Number.isInteger(p.port) || p.port < 1 || p.port > 65535)) {
      return NextResponse.json({ detail: 'Cada porta deve ser um inteiro entre 1 e 65535' }, { status: 400 })
    }
    const updated = await patchNetworkPolicyPort(ns, name, dst_ports)
    logAudit({ user_id: user.sub, username: user.username, action: 'update_policy_port', resource_type: 'NetworkPolicy', resource_name: name, namespace: ns, details: `ports=${dst_ports.map(p => `${p.protocol}/${p.port}`).join(',')}` })
    getPolicyYAML(updated.namespace, updated.name).then(y => saveManagedPolicy(updated.namespace, updated.name, y)).catch(() => {})
    emit({ type: 'policy_created' })
    return NextResponse.json(updated)
  } catch (e) {
    return NextResponse.json({ detail: String(e) }, { status: 500 })
  }
}
