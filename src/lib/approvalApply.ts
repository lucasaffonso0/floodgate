import 'server-only'
import { getDb } from './db'
import { logAudit } from './audit'
import { emit } from './sse'
import { createNetworkPolicy, createEgressNetworkPolicy, createCidrPolicy } from './k8s'
import type { Draft } from '@/types'

export async function applyDraftPolicy(draft: Draft): Promise<void> {
  if (draft.src_cidr || draft.dst_cidr) {
    await createCidrPolicy({
      namespace: draft.dst_namespace,
      service_name: draft.dst_service || undefined,
      cidr: (draft.src_cidr ?? draft.dst_cidr)!,
      except: draft.cidr_except,
      dst_ports: draft.dst_ports.length > 0 ? draft.dst_ports : undefined,
      direction: draft.src_cidr ? 'ingress' : 'egress',
    })
    return
  }
  const apiReq = {
    src_workload: draft.src_workload, src_namespace: draft.src_namespace,
    dst_service: draft.dst_service, dst_namespace: draft.dst_namespace, dst_ports: draft.dst_ports,
  }
  if (draft.policy_direction === 'ingress' || draft.policy_direction === 'both') await createNetworkPolicy(apiReq)
  if (draft.policy_direction === 'egress'  || draft.policy_direction === 'both') await createEgressNetworkPolicy(apiReq)
}

// Atomic claim: only one concurrent caller (two votes reaching quorum at
// once, or a vote racing a manual "Reaplicar") transitions into "applying".
// Stays on `status='pending'` on purpose: flipping straight to 'applied'
// before the write is confirmed would lie to a page reload or a different
// viewer if the write then failed.
export function claimApprovalApply(id: string): boolean {
  const claim = getDb().prepare(
    "UPDATE approval_requests SET applying=1, applying_started_at=datetime('now'), last_apply_error=NULL WHERE id=? AND status='pending' AND applying=0"
  ).run(id)
  return claim.changes === 1
}

// Fire-and-forget: the caller claims (claimApprovalApply), returns its HTTP
// response immediately, and calls this WITHOUT awaiting it. The actual
// write (a git commit+push in gitops mode can take real time) then runs
// detached from that request/response cycle instead of holding the
// connection open for it: `applying`/`last_apply_error` on the row is the
// only channel back to any viewer, polling or SSE-refreshed, not this
// request's own response body. Never throws: every path here ends in a DB
// update, so a bug here can't leave a row stuck without a chance for the
// scheduler's expireStaleApprovalApplies() to still catch it later.
export async function runApprovalApply(
  id: string,
  draft: Draft,
  actor: { userId: string; username: string },
  auditAction: 'auto_apply_approval_request' | 'apply_approval_request',
): Promise<void> {
  try {
    await applyDraftPolicy(draft)
    getDb().prepare("UPDATE approval_requests SET status='applied', applied_at=datetime('now'), applying=0, applying_started_at=NULL WHERE id=?").run(id)
    logAudit({ user_id: actor.userId, username: actor.username, action: auditAction, resource_type: 'ApprovalRequest', resource_name: id, namespace: draft.dst_namespace })
    emit({ type: 'approval_applied', id })
    emit({ type: 'policy_created' })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    getDb().prepare("UPDATE approval_requests SET applying=0, applying_started_at=NULL, last_apply_error=? WHERE id=?").run(msg, id)
    console.error('[floodgate] approval apply failed:', msg)
    emit({ type: 'approval_voted', id })
  }
}

// Nothing in `applying=1` can legitimately survive a process restart: it
// describes an in-flight write on the previous process's stack, which is
// gone. Same reasoning/pattern as gitopsPendingOps.clearAllPendingOps();
// called once at scheduler startup so a pod killed mid-write never leaves a
// request stuck showing "Aplicando…" forever after it comes back up.
export function resetStuckApprovals(): void {
  getDb().prepare(`
    UPDATE approval_requests SET applying=0, applying_started_at=NULL,
      last_apply_error='Interrompido por reinício do servidor. Tente reaplicar.'
    WHERE applying=1
  `).run()
}

// Belt-and-suspenders on top of the git write's own timeout: catches a
// request stuck "Aplicando…" for longer than any realistic write could
// take, without needing a restart to self-heal. maxAgeMinutes should stay
// well above the git write timeout (GIT_OP_TIMEOUT_MS in git.ts).
export function expireStaleApprovalApplies(maxAgeMinutes: number): void {
  getDb().prepare(`
    UPDATE approval_requests SET applying=0, applying_started_at=NULL,
      last_apply_error='Tempo limite excedido. Tente reaplicar.'
    WHERE applying=1 AND applying_started_at < datetime('now', ?)
  `).run(`-${maxAgeMinutes} minutes`)
}
