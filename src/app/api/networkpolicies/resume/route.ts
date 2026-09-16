import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { applyPolicyYAML, listNamespaceNames } from '@/lib/k8s'
import { getDb } from '@/lib/db'
import { apiError } from '@/lib/api-helpers'
import { logAudit } from '@/lib/audit'
import { emit } from '@/lib/sse'

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user || user.role !== 'admin') return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })

  const db = getDb()

  // Single policy resume when body contains { id }
  let body: { id?: string } = {}
  try { body = await req.json() } catch { /* no body = resume all */ }

  if (body.id) {
    const row = db.prepare('SELECT * FROM saved_policies WHERE id = ?').get(body.id) as {
      id: string; name: string; namespace: string; policy_yaml: string
    } | undefined
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    try {
      await applyPolicyYAML(row.namespace, row.policy_yaml)
      db.prepare('DELETE FROM saved_policies WHERE id = ?').run(row.id)
    } catch (e) {
      return apiError(e, 'Falha ao reativar policy', 400)
    }
    logAudit({ user_id: user.sub, username: user.username, action: 'resume_policy', resource_type: 'NetworkPolicy', resource_name: row.name, namespace: row.namespace, details: `policy resumed` })
    emit({ type: 'policy_created' })
    return NextResponse.json({ resumed: 1 })
  }

  // Resume all
  const saved = db.prepare('SELECT * FROM saved_policies').all() as {
    id: string; name: string; namespace: string; policy_yaml: string
  }[]
  const namespaces = await listNamespaceNames()

  let resumed = 0
  const failures: string[] = []
  for (const s of saved) {
    // Namespace itself is gone: this can never succeed, and it's surfaced
    // separately as an orphan for the admin to clean up (GET .../pause,
    // DELETE .../pause?id=), so skip it instead of failing every time.
    if (!namespaces.has(s.namespace)) continue
    try {
      await applyPolicyYAML(s.namespace, s.policy_yaml)
      db.prepare('DELETE FROM saved_policies WHERE id = ?').run(s.id)
      resumed++
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`[floodgate] failed to resume policy ${s.namespace}/${s.name}:`, msg)
      failures.push(`${s.namespace}/${s.name}: ${msg}`)
    }
  }

  logAudit({ user_id: user.sub, username: user.username, action: 'resume_all_policies', details: `${resumed} policies resumed, ${failures.length} failed` })
  emit({ type: 'policies_resumed' })
  return NextResponse.json({ resumed, failed: failures.length, failures })
}
