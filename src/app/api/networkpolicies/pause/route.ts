import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { listNetworkPolicies, getPolicyYAML, deleteNetworkPolicy, listNamespaceNames } from '@/lib/k8s'
import { getDb } from '@/lib/db'
import { apiError } from '@/lib/api-helpers'
import { logAudit } from '@/lib/audit'
import { emit } from '@/lib/sse'

export async function GET() {
  const user = await getCurrentUser()
  if (!user || user.role !== 'admin') return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })
  const saved = getDb().prepare('SELECT id, name, namespace, policy_yaml, saved_at FROM saved_policies').all() as
    Array<{ id: string; name: string; namespace: string; policy_yaml: string; saved_at: string }>
  const namespaces = await listNamespaceNames().catch(() => null)
  const withStatus = saved.map(s => ({
    ...s,
    // namespaces === null when the cluster listing itself failed: don't
    // falsely flag every paused policy as orphaned in that case.
    namespace_missing: namespaces ? !namespaces.has(s.namespace) : false,
  }))
  return NextResponse.json(withStatus)
}

// Drops a saved_policies row whose target namespace no longer exists — resume
// can never restore it, so it's an admin-initiated cleanup, not a cluster
// mutation (there's nothing left in the cluster to delete).
export async function DELETE(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user || user.role !== 'admin') return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })

    const id = req.nextUrl.searchParams.get('id')
    if (!id) return NextResponse.json({ detail: 'id é obrigatório' }, { status: 400 })

    const db = getDb()
    const row = db.prepare('SELECT namespace, name FROM saved_policies WHERE id = ?').get(id) as
      { namespace: string; name: string } | undefined
    if (!row) return NextResponse.json({ detail: 'Não encontrada' }, { status: 404 })

    const namespaces = await listNamespaceNames()
    if (namespaces.has(row.namespace)) {
      return NextResponse.json({ detail: 'Esta policy não está órfã (o namespace ainda existe)' }, { status: 409 })
    }

    db.prepare('DELETE FROM saved_policies WHERE id = ?').run(id)
    logAudit({
      user_id: user.sub, username: user.username,
      action: 'paused_orphan_removed',
      resource_type: 'NetworkPolicy', resource_name: row.name, namespace: row.namespace,
      details: JSON.stringify({ reason: 'namespace_missing' }),
    })

    return NextResponse.json({ ok: true })
  } catch (e) {
    return apiError(e, 'Falha ao remover policy órfã')
  }
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user || user.role !== 'admin') return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })

  const db = getDb()
  const insert = db.prepare('INSERT INTO saved_policies (name, namespace, policy_yaml) VALUES (?,?,?)')

  // Single policy pause when body contains { namespace, name }
  let body: { namespace?: string; name?: string } = {}
  try { body = await req.json() } catch { /* no body = pause all */ }

  if (body.namespace && body.name) {
    try {
      const yamlStr = await getPolicyYAML(body.namespace, body.name)
      insert.run(body.name, body.namespace, yamlStr)
      await deleteNetworkPolicy(body.namespace, body.name)
    } catch (e) {
      return apiError(e, 'Falha ao pausar policy', 400)
    }
    logAudit({ user_id: user.sub, username: user.username, action: 'pause_policy', resource_type: 'NetworkPolicy', resource_name: body.name, namespace: body.namespace, details: `policy paused` })
    emit({ type: 'policy_deleted' })
    return NextResponse.json({ paused: 1 })
  }

  // Pause all
  const policies = await listNetworkPolicies(false)
  let paused = 0
  for (const p of policies) {
    try {
      const yamlStr = await getPolicyYAML(p.namespace, p.name)
      insert.run(p.name, p.namespace, yamlStr)
      await deleteNetworkPolicy(p.namespace, p.name)
      paused++
    } catch { /* best-effort */ }
  }

  logAudit({ user_id: user.sub, username: user.username, action: 'pause_all_policies', details: `${paused} policies paused` })
  emit({ type: 'policies_paused' })
  return NextResponse.json({ paused })
}
