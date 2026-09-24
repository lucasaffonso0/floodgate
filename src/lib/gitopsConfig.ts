import 'server-only'
import type { GitOpsConfig } from '@/types'
import { getDb } from './db'

// Deliberately NOT part of AppConfig/getConfig() (src/lib/config.ts): that
// flows through GET /api/config, which any authenticated user (including
// viewers) can read. The SSH private key stored here must never reach that
// route; keeping this in its own module with its own admin-only route
// (src/app/api/gitops-config/route.ts) makes that structurally true instead
// of relying on remembering to strip a field.
const KEY_PREFIX = 'gitops_'

const DEFAULTS = {
  repo_url: '',
  repo_branch: 'main',
  repo_path: 'policies',
  commit_author_name: 'floodgate-bot',
  commit_author_email: 'floodgate@localhost',
}

function getRow(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM app_config WHERE key = ?').get(KEY_PREFIX + key) as { value: string } | undefined
  return row?.value ?? null
}

// Full connection info, including the SSH private key in plain text.
// Server-only, used by git.ts to actually authenticate. Never return this
// from an API route; use getGitOpsConfig() (below) for that.
export interface GitOpsConnection {
  repo_url: string
  repo_branch: string
  repo_path: string
  commit_author_name: string
  commit_author_email: string
  ssh_private_key: string
  ssh_known_hosts: string
}

export function getGitOpsConnection(): GitOpsConnection {
  return {
    repo_url: getRow('repo_url') ?? DEFAULTS.repo_url,
    repo_branch: getRow('repo_branch') ?? DEFAULTS.repo_branch,
    repo_path: getRow('repo_path') ?? DEFAULTS.repo_path,
    commit_author_name: getRow('commit_author_name') ?? DEFAULTS.commit_author_name,
    commit_author_email: getRow('commit_author_email') ?? DEFAULTS.commit_author_email,
    ssh_private_key: getRow('ssh_private_key') ?? '',
    ssh_known_hosts: getRow('ssh_known_hosts') ?? '',
  }
}

// Safe to hand to any API response the admin's browser reads: no secret
// material, only whether one is configured (same treatment hasS3Credentials
// gets for backup: booleans, never the value).
export function getGitOpsConfig(): GitOpsConfig {
  const c = getGitOpsConnection()
  return {
    repo_url: c.repo_url,
    repo_branch: c.repo_branch,
    repo_path: c.repo_path,
    commit_author_name: c.commit_author_name,
    commit_author_email: c.commit_author_email,
    ssh_known_hosts_configured: c.ssh_known_hosts.length > 0,
    credentials_configured: !!(c.repo_url && c.ssh_private_key),
  }
}

export function hasGitOpsCredentials(): boolean {
  const c = getGitOpsConnection()
  return !!(c.repo_url && c.ssh_private_key)
}

// Partial update: omitting ssh_private_key/ssh_known_hosts leaves the
// currently saved value untouched (the panel field is write-only: it never
// echoes the saved key back, so there's nothing for a save-without-editing
// submit to resend).
export interface GitOpsConnectionUpdate {
  repo_url?: string
  repo_branch?: string
  repo_path?: string
  commit_author_name?: string
  commit_author_email?: string
  ssh_private_key?: string
  ssh_known_hosts?: string
}

// Write-only fields: the panel's textarea always renders empty (never
// echoes the saved secret back), so a stray onChange with no real edit
// (backspacing out a typo, a paste that landed empty, clicking into the
// field and back out) produces '' just as easily as omitting the field
// entirely. Unlike an *omitted* field (undefined, correctly skipped
// below), '' is indistinguishable from "meant to clear it" once it
// reaches here. Since this form has no way to confirm "yes, actually
// delete the configured key," treat an empty string the same as
// undefined for these two fields: never let a blank submission wipe a
// working credential. Clearing the key for real means overwriting it
// with a new one, not blanking it.
const NEVER_CLEAR_WITH_EMPTY_STRING = new Set<keyof GitOpsConnectionUpdate>(['ssh_private_key', 'ssh_known_hosts'])

export function setGitOpsConnection(update: GitOpsConnectionUpdate): void {
  const db = getDb()
  const upsert = db.prepare('INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)')
  db.transaction(() => {
    for (const [key, value] of Object.entries(update) as Array<[keyof GitOpsConnectionUpdate, string | undefined]>) {
      if (value === undefined) continue
      if (value === '' && NEVER_CLEAR_WITH_EMPTY_STRING.has(key)) continue
      upsert.run(KEY_PREFIX + key, value)
    }
  })()
}
