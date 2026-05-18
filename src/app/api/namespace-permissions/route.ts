import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { getDb } from '@/lib/db'
import { logAudit } from '@/lib/audit'
import type { NamespacePermission } from '@/types'

export async function GET() {
  const user = await getCurrentUser()
  if (!user || user.role !== 'admin') return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })

  const rows = getDb().prepare(`
    SELECT np.id, np.user_id, u.username, np.namespace, np.created_at
    FROM namespace_permissions np
    JOIN users u ON u.id = np.user_id
    ORDER BY u.username, np.namespace
  `).all() as NamespacePermission[]
  return NextResponse.json(rows)
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user || user.role !== 'admin') return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })

  const { user_id, namespace } = await req.json()
  if (!user_id || !namespace) return NextResponse.json({ detail: 'user_id e namespace obrigatórios' }, { status: 400 })

  const db = getDb()
  try {
    db.prepare('INSERT OR IGNORE INTO namespace_permissions (user_id, namespace) VALUES (?, ?)').run(user_id, namespace)
    // Upgrade viewer to ns_admin
    db.prepare("UPDATE users SET role='ns_admin' WHERE id=? AND role='viewer'").run(user_id)
  } catch (e) {
    return NextResponse.json({ detail: String(e) }, { status: 400 })
  }

  const row = db.prepare(`
    SELECT np.id, np.user_id, u.username, np.namespace, np.created_at
    FROM namespace_permissions np JOIN users u ON u.id = np.user_id
    WHERE np.user_id=? AND np.namespace=?
  `).get(user_id, namespace) as NamespacePermission

  logAudit({ user_id: user.sub, username: user.username, action: 'grant_namespace_permission', resource_type: 'User', resource_name: row.username, namespace })
  return NextResponse.json(row, { status: 201 })
}
