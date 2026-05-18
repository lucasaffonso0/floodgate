import 'server-only'
import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import path from 'path'
import fs from 'fs'

type DbType = Database.Database

function initDb(): DbType {
  const isDev = process.env.NODE_ENV !== 'production'
  const DB_PATH = process.env.DB_PATH ?? (isDev ? path.join(process.cwd(), 'floodgate-dev.db') : '/data/floodgate.db')

  const dir = path.dirname(DB_PATH)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  const db = new Database(DB_PATH)
  fs.chmodSync(DB_PATH, 0o600)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  // ── Migration: add ns_admin to users.role constraint ──────────────────────
  const usersSchema = (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='users'"
  ).get() as { sql: string } | undefined)?.sql ?? ''
  if (usersSchema && !usersSchema.includes('ns_admin')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users_new (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','ns_admin','viewer')) DEFAULT 'viewer',
        created_at TEXT DEFAULT (datetime('now'))
      );
      INSERT OR IGNORE INTO users_new SELECT * FROM users;
      DROP TABLE IF EXISTS users;
      ALTER TABLE users_new RENAME TO users;
    `)
  }

  // ── Migration: add audit to users.role constraint ──────────────────────────
  const usersSchema2 = (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='users'"
  ).get() as { sql: string } | undefined)?.sql ?? ''
  if (usersSchema2 && !usersSchema2.includes('audit')) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS users_new (
        id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','ns_admin','viewer','audit')) DEFAULT 'viewer',
        created_at TEXT DEFAULT (datetime('now'))
      );
      INSERT OR IGNORE INTO users_new SELECT * FROM users;
      DROP TABLE IF EXISTS users;
      ALTER TABLE users_new RENAME TO users;
    `)
  }

  // ── Migration: add must_change_password column ────────────────────────────
  const usersCols = (db.prepare('PRAGMA table_info(users)').all() as { name: string }[]).map(c => c.name)
  if (usersCols.length > 0 && !usersCols.includes('must_change_password')) {
    db.exec(`ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0`)
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','ns_admin','viewer','audit')) DEFAULT 'viewer',
      token_version INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS app_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      user_id TEXT NOT NULL DEFAULT '',
      username TEXT NOT NULL,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL DEFAULT '',
      resource_name TEXT NOT NULL DEFAULT '',
      namespace TEXT NOT NULL DEFAULT '',
      details TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS approval_requests (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      created_by TEXT NOT NULL,
      created_by_username TEXT NOT NULL,
      draft_data TEXT NOT NULL,
      approvals_required INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','rejected','applied')),
      created_at TEXT DEFAULT (datetime('now')),
      applied_at TEXT
    );

    CREATE TABLE IF NOT EXISTS approval_votes (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      request_id TEXT NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      username TEXT NOT NULL,
      decision TEXT NOT NULL CHECK(decision IN ('approve','reject')),
      comment TEXT NOT NULL DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(request_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS namespace_permissions (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      namespace TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, namespace)
    );

    CREATE TABLE IF NOT EXISTS saved_policies (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      name TEXT NOT NULL,
      namespace TEXT NOT NULL,
      policy_yaml TEXT NOT NULL,
      saved_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS service_layouts (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
      namespace TEXT NOT NULL,
      service_name TEXT NOT NULL,
      x REAL NOT NULL DEFAULT 0,
      y REAL NOT NULL DEFAULT 0,
      locked INTEGER NOT NULL DEFAULT 1,
      updated_by TEXT NOT NULL DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(namespace, service_name)
    );

    CREATE TABLE IF NOT EXISTS namespace_layout_locks (
      namespace TEXT PRIMARY KEY,
      locked INTEGER NOT NULL DEFAULT 1,
      x INTEGER DEFAULT NULL,
      y INTEGER DEFAULT NULL,
      updated_by TEXT NOT NULL DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS managed_policies (
      namespace TEXT NOT NULL,
      name TEXT NOT NULL,
      policy_yaml TEXT NOT NULL,
      saved_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (namespace, name)
    );
  `)

  // ── Seed default admin user ────────────────────────────────────────────────
  const userCount = (db.prepare('SELECT COUNT(*) as n FROM users').get() as { n: number }).n
  if (userCount === 0) {
    const hash = bcrypt.hashSync('admin', 10)
    db.prepare("INSERT INTO users (username, password_hash, role, must_change_password) VALUES ('admin', ?, 'admin', 1)").run(hash)
  }

  // ── Migration: add token_version to users ─────────────────────────────────
  const usersSchemaFinal = (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='users'"
  ).get() as { sql: string } | undefined)?.sql ?? ''
  if (usersSchemaFinal && !usersSchemaFinal.includes('token_version')) {
    db.exec("ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1")
  }

  // ── Migration: add allowed_approvers to approval_requests ────────────────
  const arSchema = (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='approval_requests'"
  ).get() as { sql: string } | undefined)?.sql ?? ''
  if (arSchema && !arSchema.includes('allowed_approvers')) {
    db.exec("ALTER TABLE approval_requests ADD COLUMN allowed_approvers TEXT NOT NULL DEFAULT '[]'")
  }

  // ── Migration: add x, y to namespace_layout_locks ────────────────────────
  const nllSchema = (db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='namespace_layout_locks'"
  ).get() as { sql: string } | undefined)?.sql ?? ''
  if (nllSchema && !nllSchema.includes(' x ')) {
    db.exec("ALTER TABLE namespace_layout_locks ADD COLUMN x INTEGER DEFAULT NULL")
  }
  if (nllSchema && !nllSchema.includes(' y ')) {
    db.exec("ALTER TABLE namespace_layout_locks ADD COLUMN y INTEGER DEFAULT NULL")
  }

  return db
}

const g = global as typeof global & { _floodgateDb?: DbType }

export function getDb(): DbType {
  if (!g._floodgateDb) g._floodgateDb = initDb()
  return g._floodgateDb!
}
