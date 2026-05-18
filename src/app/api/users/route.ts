import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { getDb } from '@/lib/db'
import bcrypt from 'bcryptjs'

export async function GET() {
  const me = await getCurrentUser()
  if (me?.role !== 'admin') return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })

  const users = getDb().prepare('SELECT id, username, role, created_at FROM users ORDER BY created_at').all()
  return NextResponse.json(users)
}

export async function POST(req: NextRequest) {
  const me = await getCurrentUser()
  if (me?.role !== 'admin') return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })

  try {
    const { username, password, role } = await req.json()
    if (!username || !password) return NextResponse.json({ detail: 'username e password obrigatórios' }, { status: 400 })
    if (typeof password !== 'string' || password.length < 10) return NextResponse.json({ detail: 'Senha deve ter no mínimo 10 caracteres' }, { status: 400 })
    if (!['admin', 'viewer', 'audit'].includes(role)) return NextResponse.json({ detail: 'role deve ser admin, viewer ou audit' }, { status: 400 })

    const db = getDb()
    const hash = bcrypt.hashSync(password, 10)
    db.prepare('INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, ?, 1)').run(username, hash, role)
    const user = db.prepare("SELECT id, username, role, must_change_password, created_at FROM users WHERE username = ?").get(username)
    return NextResponse.json(user, { status: 201 })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    if (msg.includes('UNIQUE')) return NextResponse.json({ detail: 'Username já existe' }, { status: 409 })
    return NextResponse.json({ detail: msg }, { status: 500 })
  }
}
