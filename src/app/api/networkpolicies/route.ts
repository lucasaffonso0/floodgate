import { NextRequest, NextResponse } from 'next/server'
import { listNetworkPolicies, createNetworkPolicy, getPolicyYAML, deleteNetworkPolicy } from '@/lib/k8s'
import { getCurrentUser, canManageNamespace } from '@/lib/auth'
import { isNamespaceWatched } from '@/lib/config'
import { apiError, parseBody, invalidPortsMessage } from '@/lib/api-helpers'
import { logAudit } from '@/lib/audit'
import { saveManagedPolicy, removeManagedPolicy } from '@/lib/autosync'
import { emit } from '@/lib/sse'

export async function GET(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })
  try {
    const all = req.nextUrl.searchParams.get('all') === 'true'
    return NextResponse.json(await listNetworkPolicies(all))
  } catch (e) {
    return apiError(e, 'Falha ao listar policies')
  }
}

export async function POST(req: NextRequest) {
  try {
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
    const portsError = invalidPortsMessage(body.dst_ports)
    if (portsError) return NextResponse.json({ detail: portsError }, { status: 400 })
    if (!isNamespaceWatched(body.dst_namespace as string)) {
      return NextResponse.json({ detail: 'Namespace fora do escopo gerenciado pelo floodgate' }, { status: 400 })
    }
    if (!(await canManageNamespace(user.sub, user.role, body.dst_namespace as string))) {
      return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })
    }
    const result = await createNetworkPolicy(body as unknown as Parameters<typeof createNetworkPolicy>[0])
    logAudit({ user_id: user.sub, username: user.username, action: 'create_policy', resource_type: 'NetworkPolicy', resource_name: result.name, namespace: result.namespace })
    getPolicyYAML(result.namespace, result.name).then(y => saveManagedPolicy(result.namespace, result.name, y)).catch(() => {})
    emit({ type: 'policy_created' })
    return NextResponse.json(result, { status: 201 })
  } catch (e) {
    return apiError(e, 'Falha ao criar policy')
  }
}

// Permanently deletes every managed NetworkPolicy from the cluster — unlike
// pause (POST .../pause), there's nothing saved to restore from afterward.
export async function DELETE() {
  const user = await getCurrentUser()
  if (!user || user.role !== 'admin') return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })
  try {
    const policies = await listNetworkPolicies(false)
    let deletedCount = 0
    const failures: string[] = []
    for (const p of policies) {
      try {
        await deleteNetworkPolicy(p.namespace, p.name)
        removeManagedPolicy(p.namespace, p.name)
        deletedCount++
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.error(`[floodgate] failed to delete policy ${p.namespace}/${p.name}:`, msg)
        failures.push(`${p.namespace}/${p.name}: ${msg}`)
      }
    }
    logAudit({ user_id: user.sub, username: user.username, action: 'delete_all_policies', details: `${deletedCount} policies deleted, ${failures.length} failed` })
    emit({ type: 'policy_deleted' })
    return NextResponse.json({ deleted: deletedCount, failed: failures.length, failures })
  } catch (e) {
    return apiError(e, 'Falha ao apagar policies')
  }
}
