import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { getDb } from '@/lib/db'
import bcrypt from 'bcryptjs'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const me = await getCurrentUser()
  if (!me) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const body = await req.json()

  const isAdmin = me.role === 'admin'
  const isSelf  = me.sub === id

  // Only admin can touch other users
  if (!isAdmin && !isSelf) {
    return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })
  }

  // Role changes: admin only
  if (body.role !== undefined && !isAdmin) {
    return NextResponse.json({ detail: 'Forbidden — apenas admins podem alterar roles' }, { status: 403 })
  }

  // Password change validation
  if (body.password !== undefined) {
    if (typeof body.password !== 'string' || body.password.length < 10) {
      return NextResponse.json({ detail: 'Senha deve ter no mínimo 10 caracteres' }, { status: 400 })
    }

    // Non-admin changing own password must provide and verify current password
    if (!isAdmin) {
      if (!body.current_password) {
        return NextResponse.json({ detail: 'Senha atual é obrigatória' }, { status: 400 })
      }
      const row = getDb()
        .prepare('SELECT password_hash FROM users WHERE id = ?')
        .get(id) as { password_hash: string } | undefined
      if (!row || !bcrypt.compareSync(body.current_password, row.password_hash)) {
        return NextResponse.json({ detail: 'Senha atual incorreta' }, { status: 400 })
      }
    }
  }

  if (body.role && !['admin', 'ns_admin', 'viewer', 'audit'].includes(body.role)) {
    return NextResponse.json({ detail: 'role inválido' }, { status: 400 })
  }

  const db = getDb()
  if (body.password && body.role && isAdmin) {
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, role = ?, token_version = token_version + 1 WHERE id = ?')
      .run(bcrypt.hashSync(body.password, 10), body.role, id)
  } else if (body.password) {
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, token_version = token_version + 1 WHERE id = ?')
      .run(bcrypt.hashSync(body.password, 10), id)
  } else if (body.role && isAdmin) {
    db.prepare('UPDATE users SET role = ?, token_version = token_version + 1 WHERE id = ?')
      .run(body.role, id)
  }

  const user = db.prepare('SELECT id, username, role, must_change_password, created_at FROM users WHERE id = ?').get(id)
  if (!user) return NextResponse.json({ detail: 'Not found' }, { status: 404 })
  return NextResponse.json(user)
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const me = await getCurrentUser()
  if (me?.role !== 'admin') return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })

  const { id } = await params
  if (me.sub === id) return NextResponse.json({ detail: 'Não é possível deletar sua própria conta' }, { status: 400 })

  const info = getDb().prepare('DELETE FROM users WHERE id = ?').run(id)
  if (info.changes === 0) return NextResponse.json({ detail: 'Not found' }, { status: 404 })
  return new NextResponse(null, { status: 204 })
}
