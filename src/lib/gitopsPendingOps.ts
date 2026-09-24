import 'server-only'
import { getDb } from './db'

// Persisted (not just in-memory React state) so a page reload mid-write
// still shows "aplicando/removendo" for the right item, instead of it just
// vanishing until the commit+push finishes. commitPolicyFilesTracked()
// (k8s-gitops.ts) is the one writer/eraser of this table, wrapping every
// GitOps write in start/finish regardless of outcome.
export interface PendingOp {
  namespace: string
  name: string
  kind: 'apply' | 'delete'
  started_at: string
}

export function startPendingOp(namespace: string, name: string, kind: 'apply' | 'delete'): void {
  getDb().prepare(`
    INSERT OR REPLACE INTO gitops_pending_ops (namespace, name, kind, started_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(namespace, name, kind)
}

export function finishPendingOp(namespace: string, name: string): void {
  getDb().prepare('DELETE FROM gitops_pending_ops WHERE namespace = ? AND name = ?').run(namespace, name)
}

export function listPendingOps(): PendingOp[] {
  return getDb().prepare('SELECT namespace, name, kind, started_at FROM gitops_pending_ops').all() as PendingOp[]
}

// Nothing in this table can legitimately survive a process restart: every
// row describes work tied to the previous process's memory (the
// withGitLock promise chain, the in-flight commitPolicyFilesTracked call),
// none of which exists anymore once the process comes back up. Called once
// at scheduler startup (scheduler.ts), same guard pattern as the scheduler
// itself, so a pod that died mid-write never leaves a phantom "aplicando/
// removendo" badge stuck in the UI after it restarts.
export function clearAllPendingOps(): void {
  getDb().prepare('DELETE FROM gitops_pending_ops').run()
}

// Belt-and-suspenders on top of git.ts's own write timeout: even with that
// timeout, defends against any other way a row could linger past when the
// write it tracks actually settled. maxAgeMinutes should stay well above
// any realistic commit+push+retry duration; this is meant to catch stuck
// rows, not to cut off slow-but-healthy operations.
export function expireStalePendingOps(maxAgeMinutes: number): void {
  getDb().prepare(`DELETE FROM gitops_pending_ops WHERE started_at < datetime('now', ?)`).run(`-${maxAgeMinutes} minutes`)
}
