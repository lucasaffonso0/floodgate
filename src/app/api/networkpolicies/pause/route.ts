import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { listNetworkPolicies, getPolicyYAML, deleteNetworkPolicy } from '@/lib/k8s'
import { getDb } from '@/lib/db'
import { logAudit } from '@/lib/audit'
import { emit } from '@/lib/sse'

export async function GET() {
  const user = await getCurrentUser()
  if (!user || user.role !== 'admin') return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })
  const saved = getDb().prepare('SELECT id, name, namespace, policy_yaml, saved_at FROM saved_policies').all()
  return NextResponse.json(saved)
}

export async function POST() {
  const user = await getCurrentUser()
  if (!user || user.role !== 'admin') return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })

  const policies = await listNetworkPolicies(false)
  const db = getDb()
  const insert = db.prepare('INSERT INTO saved_policies (name, namespace, policy_yaml) VALUES (?,?,?)')

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
