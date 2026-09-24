import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

vi.mock('server-only', () => ({}))

// Real in-memory SQLite (not a mocked getDb()): expireStalePendingOps()'s
// correctness hinges on SQLite's own datetime('now', ?) semantics, which a
// mock would just hide instead of proving. Only the one table this module
// touches, not the full app schema from db.ts.
const db = new Database(':memory:')
db.exec(`
  CREATE TABLE gitops_pending_ops (
    namespace TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('apply','delete')),
    started_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (namespace, name)
  );
`)
vi.mock('./db', () => ({ getDb: () => db }))

const { startPendingOp, finishPendingOp, listPendingOps, clearAllPendingOps, expireStalePendingOps } = await import('./gitopsPendingOps')

beforeEach(() => {
  db.exec('DELETE FROM gitops_pending_ops')
})

describe('gitopsPendingOps', () => {
  it('startPendingOp then listPendingOps round-trips namespace/name/kind', () => {
    startPendingOp('backend', 'floodgate-restrict-ingress-worker', 'apply')
    const rows = listPendingOps()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ namespace: 'backend', name: 'floodgate-restrict-ingress-worker', kind: 'apply' })
  })

  it('finishPendingOp removes only the matching row', () => {
    startPendingOp('backend', 'a', 'apply')
    startPendingOp('backend', 'b', 'delete')
    finishPendingOp('backend', 'a')
    const rows = listPendingOps()
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('b')
  })

  it('startPendingOp is an upsert: calling it again for the same policy replaces the row, not duplicates it', () => {
    startPendingOp('backend', 'a', 'apply')
    startPendingOp('backend', 'a', 'delete')
    const rows = listPendingOps()
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('delete')
  })

  // clearAllPendingOps: nothing in this table can legitimately survive a
  // process restart (see the comment on it in gitopsPendingOps.ts);
  // called once at scheduler startup.
  it('clearAllPendingOps empties the table unconditionally', () => {
    startPendingOp('backend', 'a', 'apply')
    startPendingOp('cache', 'b', 'delete')
    clearAllPendingOps()
    expect(listPendingOps()).toEqual([])
  })

  describe('expireStalePendingOps', () => {
    it('removes a row older than the given age, keeps a fresh one', () => {
      db.prepare(`INSERT INTO gitops_pending_ops (namespace, name, kind, started_at) VALUES (?, ?, ?, datetime('now', '-10 minutes'))`)
        .run('backend', 'stuck', 'apply')
      startPendingOp('backend', 'fresh', 'delete') // started_at defaults to now

      expireStalePendingOps(5)

      const rows = listPendingOps()
      expect(rows).toHaveLength(1)
      expect(rows[0].name).toBe('fresh')
    })

    it('does not touch a row younger than the given age', () => {
      db.prepare(`INSERT INTO gitops_pending_ops (namespace, name, kind, started_at) VALUES (?, ?, ?, datetime('now', '-2 minutes'))`)
        .run('backend', 'still-going', 'apply')

      expireStalePendingOps(5)

      expect(listPendingOps()).toHaveLength(1)
    })
  })
})
