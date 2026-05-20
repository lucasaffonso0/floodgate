import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser, canManageNamespace } from '@/lib/auth'
import { getDb } from '@/lib/db'
import { logAudit } from '@/lib/audit'
import { emit } from '@/lib/sse'
import { createNetworkPolicy, createEgressNetworkPolicy, previewPolicyYAML } from '@/lib/k8s'
import type { ApprovalRequest, Draft, PortSpec } from '@/types'

function normalizeDraft(draft: Draft & { dst_port?: number }): Draft {
  if (draft.dst_ports === undefined) {
    return { ...draft, dst_ports: [{ port: Number(draft.dst_port ?? 80), protocol: 'TCP' as PortSpec['protocol'] }] }
  }
  return draft
}

type Params = { params: Promise<{ id: string }> }

function resolveEffectiveApprovers(
  db: ReturnType<typeof getDb>,
  storedApprovers: Array<{ id: string; username: string }>,
  dstNamespace: string,
): Array<{ id: string; username: string }> {
  if (storedApprovers.length > 0) return storedApprovers

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

function getRequest(id: string): ApprovalRequest | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM approval_requests WHERE id = ?').get(id) as Record<string, unknown> | undefined
  if (!row) return null
  const votes = db.prepare('SELECT * FROM approval_votes WHERE request_id = ? ORDER BY created_at ASC').all(id) as ApprovalRequest['votes']
  const storedApprovers: Array<{ id: string; username: string }> = JSON.parse((row.allowed_approvers as string | undefined) ?? '[]')
  let draftData: Omit<Draft, 'id'>
  try {
    draftData = JSON.parse(row.draft_data as string) as Omit<Draft, 'id'>
  } catch {
    return null
  }
  return {
    id: row.id as string,
    created_by: row.created_by as string,
    created_by_username: row.created_by_username as string,
    draft_data: draftData,
    status: row.status as ApprovalRequest['status'],
    approvals_required: row.approvals_required as number,
    approve_count: votes.filter(v => v.decision === 'approve').length,
    reject_count:  votes.filter(v => v.decision === 'reject').length,
    allowed_approvers: resolveEffectiveApprovers(db, storedApprovers, draftData.dst_namespace),
    votes,
    created_at: row.created_at as string,
    applied_at: (row.applied_at as string | null) ?? null,
  }
}

export async function GET(httpReq: NextRequest, { params }: Params) {
  const { id } = await params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })

  if (httpReq.nextUrl.searchParams.get('yaml') === '1') {
    const req = getRequest(id)
    if (!req) return NextResponse.json({ detail: 'Not found' }, { status: 404 })
    const draft = normalizeDraft(req.draft_data as Draft & { dst_port?: number })
    try {
      const yamlStr = await previewPolicyYAML(
        { src_workload: draft.src_workload, src_namespace: draft.src_namespace, dst_service: draft.dst_service, dst_namespace: draft.dst_namespace, dst_ports: draft.dst_ports },
        draft.policy_direction,
      )
      return new NextResponse(yamlStr, { headers: { 'Content-Type': 'text/plain' } })
    } catch (e) {
      return NextResponse.json({ detail: String(e) }, { status: 500 })
    }
  }

  const req = getRequest(id)
  if (!req) return NextResponse.json({ detail: 'Not found' }, { status: 404 })
  return NextResponse.json(req)
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params
  const user = await getCurrentUser()
  if (!user || user.role === 'audit') return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })
  if (user.role === 'viewer') return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })
  const row = getDb().prepare('SELECT created_by, status FROM approval_requests WHERE id = ?').get(id) as { created_by: string; status: string } | undefined
  if (!row) return NextResponse.json({ detail: 'Not found' }, { status: 404 })
  if (row.status !== 'pending') return NextResponse.json({ detail: 'Só pode cancelar requests pendentes' }, { status: 400 })
  if (user.role !== 'admin' && user.sub !== row.created_by) return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })
  getDb().prepare('DELETE FROM approval_requests WHERE id = ?').run(id)
  logAudit({ user_id: user.sub, username: user.username, action: 'cancel_approval_request', resource_type: 'ApprovalRequest', resource_name: id })
  emit({ type: 'approval_cancelled', id })
  return new NextResponse(null, { status: 204 })
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })
  // audit role can never mutate
  if (user.role === 'audit') return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })

  const { action, comment, decision } = await req.json()

  if (action === 'vote') {
    // Viewers can vote if explicitly listed as an approver (checked below)
    if (user.role === 'viewer') {
      const row = getDb().prepare('SELECT allowed_approvers FROM approval_requests WHERE id = ?').get(id) as { allowed_approvers?: string } | undefined
      if (!row) return NextResponse.json({ detail: 'Not found' }, { status: 404 })
      const approvers: Array<{ id: string }> = JSON.parse(row.allowed_approvers ?? '[]')
      if (approvers.length === 0 || !approvers.some(a => a.id === user.sub)) {
        return NextResponse.json({ detail: 'Viewers só podem votar quando explicitamente listados como aprovadores' }, { status: 403 })
      }
    }
    if (!['approve', 'reject'].includes(decision)) return NextResponse.json({ detail: 'decision inválido' }, { status: 400 })
    const row = getDb().prepare('SELECT status, allowed_approvers FROM approval_requests WHERE id = ?').get(id) as { status: string; allowed_approvers?: string } | undefined
    if (!row) return NextResponse.json({ detail: 'Not found' }, { status: 404 })
    if (row.status !== 'pending') return NextResponse.json({ detail: 'Request não está pendente' }, { status: 400 })
    const allowedApprovers: Array<{ id: string; username: string }> = JSON.parse(row.allowed_approvers ?? '[]')
    if (user.role !== 'admin' && allowedApprovers.length > 0 && !allowedApprovers.some(a => a.id === user.sub)) {
      return NextResponse.json({ detail: 'Você não está na lista de aprovadores deste request' }, { status: 403 })
    }

    try {
      getDb().prepare(`
        INSERT INTO approval_votes (request_id, user_id, username, decision, comment) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(request_id, user_id) DO UPDATE SET decision=excluded.decision, comment=excluded.comment, created_at=datetime('now')
      `).run(id, user.sub, user.username, decision, comment ?? '')
    } catch (e) {
      return NextResponse.json({ detail: String(e) }, { status: 400 })
    }

    // Auto-reject if anyone rejects
    if (decision === 'reject') {
      getDb().prepare("UPDATE approval_requests SET status='rejected' WHERE id = ?").run(id)
      logAudit({ user_id: user.sub, username: user.username, action: 'reject_approval_request', resource_type: 'ApprovalRequest', resource_name: id })
      emit({ type: 'approval_rejected', id })
      return NextResponse.json(getRequest(id))
    }

    logAudit({ user_id: user.sub, username: user.username, action: 'approve_vote', resource_type: 'ApprovalRequest', resource_name: id })

    // Auto-apply when quorum is reached — the approval workflow is the authorization mechanism,
    // so the policy is applied regardless of the individual voter's namespace permissions.
    const updated = getRequest(id)!
    let autoApplyError: string | null = null
    if (updated.approve_count >= updated.approvals_required && updated.reject_count === 0) {
      const draft = normalizeDraft(updated.draft_data as Draft & { dst_port?: number })
      const apiReq = {
        src_workload: draft.src_workload, src_namespace: draft.src_namespace,
        dst_service: draft.dst_service, dst_namespace: draft.dst_namespace, dst_ports: draft.dst_ports,
      }
      try {
        if (draft.policy_direction === 'ingress' || draft.policy_direction === 'both') await createNetworkPolicy(apiReq)
        if (draft.policy_direction === 'egress'  || draft.policy_direction === 'both') await createEgressNetworkPolicy(apiReq)
        getDb().prepare("UPDATE approval_requests SET status='applied', applied_at=datetime('now') WHERE id=?").run(id)
        logAudit({ user_id: user.sub, username: user.username, action: 'auto_apply_approval_request', resource_type: 'ApprovalRequest', resource_name: id, namespace: draft.dst_namespace })
        emit({ type: 'approval_applied', id })
        emit({ type: 'policy_created' })
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        console.error('[floodgate] auto-apply failed:', msg)
        autoApplyError = msg
        emit({ type: 'approval_voted', id })
      }
    } else {
      emit({ type: 'approval_voted', id })
    }

    return NextResponse.json({ ...getRequest(id), auto_apply_error: autoApplyError })
  }

  if (action === 'apply') {
    if (user.role === 'viewer') return NextResponse.json({ detail: 'Viewers não podem aplicar approval requests' }, { status: 403 })
    const request = getRequest(id)
    if (!request) return NextResponse.json({ detail: 'Not found' }, { status: 404 })
    if (request.status !== 'pending') return NextResponse.json({ detail: 'Request não está pendente' }, { status: 400 })
    if (user.role !== 'admin' && request.approve_count < request.approvals_required) {
      return NextResponse.json({ detail: `Necessário ${request.approvals_required} aprovação(ões), tem ${request.approve_count}` }, { status: 400 })
    }
    if (request.reject_count > 0) return NextResponse.json({ detail: 'Request rejeitado' }, { status: 400 })

    const draft = normalizeDraft(request.draft_data as Draft & { dst_port?: number })
    const canManage = await canManageNamespace(user.sub, user.role, draft.dst_namespace)
    if (!canManage) return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })

    const apiReq = {
      src_workload: draft.src_workload, src_namespace: draft.src_namespace,
      dst_service: draft.dst_service,   dst_namespace: draft.dst_namespace, dst_ports: draft.dst_ports,
    }
    if (draft.policy_direction === 'ingress' || draft.policy_direction === 'both') await createNetworkPolicy(apiReq)
    if (draft.policy_direction === 'egress'  || draft.policy_direction === 'both') await createEgressNetworkPolicy(apiReq)

    getDb().prepare("UPDATE approval_requests SET status='applied', applied_at=datetime('now') WHERE id=?").run(id)
    logAudit({ user_id: user.sub, username: user.username, action: 'apply_approval_request', resource_type: 'ApprovalRequest', resource_name: id, namespace: draft.dst_namespace })
    emit({ type: 'approval_applied', id })
    emit({ type: 'policy_created' })
    return NextResponse.json(getRequest(id))
  }

  return NextResponse.json({ detail: 'action inválida' }, { status: 400 })
}
