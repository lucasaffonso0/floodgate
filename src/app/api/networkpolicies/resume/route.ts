import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { applyPolicyYAML } from '@/lib/k8s'
import { getDb } from '@/lib/db'
import { logAudit } from '@/lib/audit'
import { emit } from '@/lib/sse'

export async function POST() {
  const user = await getCurrentUser()
  if (!user || user.role !== 'admin') return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })

  const db = getDb()
  const saved = db.prepare('SELECT * FROM saved_policies').all() as {
    id: string; name: string; namespace: string; policy_yaml: string
  }[]

  let resumed = 0
  for (const s of saved) {
    try {
      await applyPolicyYAML(s.namespace, s.policy_yaml)
      db.prepare('DELETE FROM saved_policies WHERE id = ?').run(s.id)
      resumed++
    } catch { /* best-effort */ }
  }

  logAudit({ user_id: user.sub, username: user.username, action: 'resume_all_policies', details: `${resumed} policies resumed` })
  emit({ type: 'policies_resumed' })
  return NextResponse.json({ resumed })
}
