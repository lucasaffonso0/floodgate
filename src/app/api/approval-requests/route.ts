import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser, canManageNamespace } from '@/lib/auth'
import { getDb } from '@/lib/db'
import { getConfig } from '@/lib/config'
import { logAudit } from '@/lib/audit'
import { emit } from '@/lib/sse'
import type { ApprovalRequest } from '@/types'

function resolveEffectiveApprovers(
  db: ReturnType<typeof getDb>,
  explicitApprovers: Array<{ id: string; username: string }>,
  dstNamespace: string,
): Array<{ id: string; username: string }> {
  if (explicitApprovers.length > 0) return explicitApprovers

  const admins = db.prepare(
    "SELECT id, username FROM users WHERE role = 'admin'"
  ).all() as Array<{ id: string; username: string }>

  const nsAdmins = db.prepare(`
    SELECT u.id, u.username FROM users u
    INNER JOIN namespace_permissions np ON np.user_id = u.id
    WHERE u.role = 'ns_admin' AND np.namespace = ?
  `).all(dstNamespace) as Array<{ id: string; username: string }>

  const seen = new Set<string>()
  return [...admins, ...nsAdmins].filter(u => {
    if (seen.has(u.id)) return false
    seen.add(u.id)
    return true
  })
}

function buildRequest(row: Record<string, unknown>): ApprovalRequest {
  const db = getDb()
  const votes = db.prepare(
    'SELECT * FROM approval_votes WHERE request_id = ? ORDER BY created_at ASC'
  ).all(row.id as string) as ApprovalRequest['votes']
  const approve_count = votes.filter(v => v.decision === 'approve').length
  const reject_count  = votes.filter(v => v.decision === 'reject').length
  const storedApprovers: Array<{ id: string; username: string }> = JSON.parse((row.allowed_approvers as string | undefined) ?? '[]')
  const draftData = JSON.parse(row.draft_data as string)
  const allowed_approvers = resolveEffectiveApprovers(db, storedApprovers, draftData.dst_namespace)
  return {
    id: row.id as string,
    created_by: row.created_by as string,
    created_by_username: row.created_by_username as string,
    draft_data: draftData,
    status: row.status as ApprovalRequest['status'],
    approvals_required: row.approvals_required as number,
    approve_count,
    reject_count,
    allowed_approvers,
    votes,
    created_at: row.created_at as string,
    applied_at: (row.applied_at as string | null) ?? null,
  }
}

export async function GET(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user || user.role === 'audit') return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })
  const status = req.nextUrl.searchParams.get('status') ?? 'pending'
  const rows = getDb().prepare(
    'SELECT * FROM approval_requests WHERE status = ? ORDER BY created_at DESC'
  ).all(status) as Record<string, unknown>[]
  const all = rows.map(buildRequest)
  // Viewers only see requests they can vote on (listed as approver, or open to all)
  if (user.role === 'viewer') {
    return NextResponse.json(all.filter(r => {
      const approvers: Array<{ id: string }> = r.allowed_approvers
      return approvers.length === 0 || approvers.some(a => a.id === user.sub)
    }))
  }
  return NextResponse.json(all)
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user || user.role === 'viewer') return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })
  const cfg = getConfig()
  if (!cfg.approval_enabled) return NextResponse.json({ detail: 'Approval workflow desativado' }, { status: 400 })

  const { allowed_approvers = [], ...draft } = await req.json()

  if (!draft.dst_namespace || !draft.src_namespace || !draft.dst_service) {
    return NextResponse.json({ detail: 'dst_namespace, src_namespace e dst_service são obrigatórios' }, { status: 400 })
  }

  if (!(await canManageNamespace(user.sub, user.role, draft.dst_namespace))) {
    return NextResponse.json({ detail: 'Sem permissão para criar drafts neste namespace' }, { status: 403 })
  }

  const db = getDb()

  const effectiveApprovers = resolveEffectiveApprovers(db, allowed_approvers, draft.dst_namespace)

  const result = db.prepare(`
    INSERT INTO approval_requests (created_by, created_by_username, draft_data, approvals_required, allowed_approvers)
    VALUES (?, ?, ?, ?, ?)
  `).run(user.sub, user.username, JSON.stringify(draft), cfg.approval_required_count, JSON.stringify(effectiveApprovers))

  const row = db.prepare('SELECT * FROM approval_requests WHERE rowid = ?').get(result.lastInsertRowid) as Record<string, unknown>
  logAudit({ user_id: user.sub, username: user.username, action: 'create_approval_request', resource_type: 'ApprovalRequest', resource_name: row.id as string })
  emit({ type: 'approval_created', id: row.id as string, created_by: user.sub, allowed_approvers: effectiveApprovers })
  return NextResponse.json(buildRequest(row), { status: 201 })
}
