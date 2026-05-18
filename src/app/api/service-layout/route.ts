import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser, canManageNamespace } from '@/lib/auth'
import { getDb } from '@/lib/db'
import { listServices } from '@/lib/k8s'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })

  const services = await listServices()
  const allNamespaces = [...new Set(services.map(s => s.namespace))]
  const db = getDb()
  const rows = db.prepare(
    `SELECT id, namespace, service_name, x, y, locked, updated_by, updated_at
     FROM service_layouts
     ORDER BY namespace, service_name`
  ).all() as Array<{
    id: string
    namespace: string
    service_name: string
    x: number
    y: number
    locked: number
    updated_by: string
    updated_at: string
  }>
  const locks = db.prepare(
    `SELECT namespace, locked, x, y, updated_by, updated_at
     FROM namespace_layout_locks`
  ).all() as Array<{ namespace: string; locked: number; x: number | null; y: number | null; updated_by: string; updated_at: string }>

  const metaRow = db.prepare(
    `SELECT updated_by, updated_at FROM namespace_layout_locks WHERE namespace = '__meta__' LIMIT 1`
  ).get() as { updated_by: string; updated_at: string } | undefined

  const globalRow = db.prepare(
    `SELECT locked FROM namespace_layout_locks WHERE namespace = '__global__' LIMIT 1`
  ).get() as { locked: number } | undefined

  const visibleLocks = locks.filter(r => r.namespace !== '__meta__' && r.namespace !== '__global__')

  return NextResponse.json({
    layouts: rows.map(r => ({ ...r, locked: r.locked === 1 })),
    namespace_locks: visibleLocks.map(r => ({ ...r, locked: r.locked === 1, x: r.x ?? null, y: r.y ?? null })),
    namespaces: allNamespaces,
    layout_meta: metaRow ? { saved_by: metaRow.updated_by, saved_at: metaRow.updated_at } : null,
    global_locked: globalRow ? globalRow.locked === 1 : false,
  })
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })

  const { namespace, service_name, x, y } = await req.json()
  if (!namespace || !service_name || typeof x !== 'number' || typeof y !== 'number') {
    return NextResponse.json({ detail: 'Campos obrigatórios: namespace, service_name, x, y' }, { status: 400 })
  }

  if (!(await canManageNamespace(user.sub, user.role, namespace))) {
    return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })
  }

  const db = getDb()
  const nsLock = db.prepare(
    'SELECT locked FROM namespace_layout_locks WHERE namespace = ?'
  ).get(namespace) as { locked: number } | undefined
  if ((nsLock?.locked ?? 0) === 1) {
    return NextResponse.json({ detail: 'Namespace bloqueado para ajustes' }, { status: 403 })
  }

  db.prepare(`
    INSERT INTO service_layouts (namespace, service_name, x, y, locked, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(namespace, service_name)
    DO UPDATE SET x=excluded.x, y=excluded.y, updated_by=excluded.updated_by, updated_at=datetime('now')
  `).run(namespace, service_name, x, y, 0, user.sub)

  const row = db.prepare(
    'SELECT id, namespace, service_name, x, y, locked, updated_by, updated_at FROM service_layouts WHERE namespace = ? AND service_name = ?'
  ).get(namespace, service_name) as {
    id: string
    namespace: string
    service_name: string
    x: number
    y: number
    locked: number
    updated_by: string
    updated_at: string
  }

  return NextResponse.json({ ...row, locked: row.locked === 1 })
}

export async function PATCH(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })
  if (user.role === 'viewer' || user.role === 'audit') return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })

  const body = await req.json()
  const { scope } = body
  const db = getDb()

  if (scope === 'save-all') {
    const { services, namespaces } = body as {
      services: Array<{ namespace: string; service_name: string; x: number; y: number }>
      namespaces: Array<{ namespace: string; x: number; y: number }>
    }
    const upsertSvc = db.prepare(`
      INSERT INTO service_layouts (namespace, service_name, x, y, locked, updated_by, updated_at)
      VALUES (?, ?, ?, ?, 0, ?, datetime('now'))
      ON CONFLICT(namespace, service_name)
      DO UPDATE SET x=excluded.x, y=excluded.y, updated_by=excluded.updated_by, updated_at=datetime('now')
    `)
    const upsertNs = db.prepare(`
      INSERT INTO namespace_layout_locks (namespace, locked, x, y, updated_by, updated_at)
      VALUES (?, 0, ?, ?, ?, datetime('now'))
      ON CONFLICT(namespace)
      DO UPDATE SET x=excluded.x, y=excluded.y, updated_by=excluded.updated_by, updated_at=datetime('now')
    `)
    const upsertMeta = db.prepare(`
      INSERT INTO namespace_layout_locks (namespace, locked, x, y, updated_by, updated_at)
      VALUES ('__meta__', 0, NULL, NULL, ?, datetime('now'))
      ON CONFLICT(namespace)
      DO UPDATE SET locked=0, x=NULL, y=NULL, updated_by=excluded.updated_by, updated_at=datetime('now')
    `)
    const saveAll = db.transaction(() => {
      for (const svc of services) upsertSvc.run(svc.namespace, svc.service_name, svc.x, svc.y, user.sub)
      for (const ns of namespaces) upsertNs.run(ns.namespace, ns.x, ns.y, user.sub)
      upsertMeta.run(user.sub)
    })
    saveAll()
    return NextResponse.json({ ok: true, saved_by: user.username, saved_at: new Date().toISOString() })
  }

  if (scope === 'global-lock') {
    if (user.role !== 'admin') return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })
    const { locked } = body as { locked: boolean }
    if (typeof locked !== 'boolean') return NextResponse.json({ detail: 'locked deve ser boolean' }, { status: 400 })
    db.prepare(`
      INSERT INTO namespace_layout_locks (namespace, locked, updated_by, updated_at)
      VALUES ('__global__', ?, ?, datetime('now'))
      ON CONFLICT(namespace)
      DO UPDATE SET locked=excluded.locked, updated_by=excluded.updated_by, updated_at=datetime('now')
    `).run(locked ? 1 : 0, user.sub)
    return NextResponse.json({ ok: true, locked })
  }

  const { namespace, locked } = body
  if (typeof locked !== 'boolean') return NextResponse.json({ detail: 'locked deve ser boolean' }, { status: 400 })

  if (scope === 'all') {
    if (user.role !== 'admin') return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })
    const services = await listServices()
    const namespaces = [...new Set(services.map(s => s.namespace))]
    const upsertLock = db.prepare(`
      INSERT INTO namespace_layout_locks (namespace, locked, updated_by, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(namespace)
      DO UPDATE SET locked=excluded.locked, updated_by=excluded.updated_by, updated_at=datetime('now')
    `)
    const updateSvc = db.prepare('UPDATE service_layouts SET locked = ?, updated_by = ?, updated_at = datetime(\'now\') WHERE namespace = ?')
    for (const ns of namespaces) {
      upsertLock.run(ns, locked ? 1 : 0, user.sub)
      updateSvc.run(locked ? 1 : 0, user.sub, ns)
    }
    return NextResponse.json({ updated: true, scope: 'all', locked })
  }

  if (scope !== 'namespace' || !namespace) {
    return NextResponse.json({ detail: 'Use scope=namespace com namespace, ou scope=all' }, { status: 400 })
  }

  if (!(await canManageNamespace(user.sub, user.role, namespace))) {
    return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })
  }

  db.prepare(`
    INSERT INTO namespace_layout_locks (namespace, locked, updated_by, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(namespace)
    DO UPDATE SET locked=excluded.locked, updated_by=excluded.updated_by, updated_at=datetime('now')
  `).run(namespace, locked ? 1 : 0, user.sub)
  db.prepare(
    'UPDATE service_layouts SET locked = ?, updated_by = ?, updated_at = datetime(\'now\') WHERE namespace = ?'
  ).run(locked ? 1 : 0, user.sub, namespace)

  return NextResponse.json({ updated: true, scope: 'namespace', namespace, locked })
}
