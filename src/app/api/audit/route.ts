import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { getDb } from '@/lib/db'
import type { AuditLog } from '@/types'

export async function GET(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user || (user.role !== 'admin' && user.role !== 'audit')) return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })

  const limit  = Math.min(Math.max(1, parseInt(req.nextUrl.searchParams.get('limit')  ?? '100') || 100), 1000)
  const offset = Math.max(0, parseInt(req.nextUrl.searchParams.get('offset') ?? '0') || 0)
  const ns     = req.nextUrl.searchParams.get('namespace')
  const action = req.nextUrl.searchParams.get('action')

  let sql = 'SELECT * FROM audit_logs WHERE 1=1'
  const params: unknown[] = []
  if (ns)     { sql += ' AND namespace LIKE ?';  params.push(`%${ns}%`) }
  if (action) { sql += ' AND action LIKE ?';     params.push(`%${action}%`) }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?'
  params.push(limit, offset)

  const db = getDb()
  const logs = db.prepare(sql).all(...params) as AuditLog[]

  let countSql = 'SELECT COUNT(*) as n FROM audit_logs WHERE 1=1'
  const countParams: unknown[] = []
  if (ns)     { countSql += ' AND namespace LIKE ?'; countParams.push(`%${ns}%`) }
  if (action) { countSql += ' AND action LIKE ?'; countParams.push(`%${action}%`) }
  const total = (db.prepare(countSql).get(...countParams) as { n: number }).n

  return NextResponse.json({ logs, total })
}
