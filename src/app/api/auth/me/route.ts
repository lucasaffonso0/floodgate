import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { getDb } from '@/lib/db'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })

  const db = getDb()
  const row = db.prepare('SELECT id, username, role, must_change_password, created_at FROM users WHERE id = ?').get(user.sub) as
    | { id: string; username: string; role: string; must_change_password: number; created_at: string }
    | undefined
  if (!row) return NextResponse.json({ detail: 'User not found' }, { status: 404 })

  const perms = db.prepare('SELECT namespace FROM namespace_permissions WHERE user_id = ?').all(user.sub) as { namespace: string }[]
  return NextResponse.json({
    ...row,
    must_change_password: row.must_change_password === 1,
    allowed_namespaces: perms.map(p => p.namespace),
  })
}
