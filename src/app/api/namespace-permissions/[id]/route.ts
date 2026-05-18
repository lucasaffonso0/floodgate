import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { getDb } from '@/lib/db'
import { logAudit } from '@/lib/audit'

type Params = { params: Promise<{ id: string }> }

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params
  const user = await getCurrentUser()
  if (!user || user.role !== 'admin') return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })

  const db = getDb()
  const perm = db.prepare(`
    SELECT np.user_id, u.username, np.namespace
    FROM namespace_permissions np JOIN users u ON u.id=np.user_id
    WHERE np.id=?
  `).get(id) as { user_id: string; username: string; namespace: string } | undefined
  if (!perm) return NextResponse.json({ detail: 'Not found' }, { status: 404 })

  db.prepare('DELETE FROM namespace_permissions WHERE id=?').run(id)

  // Downgrade to viewer if no permissions left
  const remaining = (db.prepare('SELECT COUNT(*) as n FROM namespace_permissions WHERE user_id=?').get(perm.user_id) as { n: number }).n
  if (remaining === 0) {
    db.prepare("UPDATE users SET role='viewer' WHERE id=? AND role='ns_admin'").run(perm.user_id)
  }

  logAudit({ user_id: user.sub, username: user.username, action: 'revoke_namespace_permission', resource_type: 'User', resource_name: perm.username, namespace: perm.namespace })
  return new NextResponse(null, { status: 204 })
}
