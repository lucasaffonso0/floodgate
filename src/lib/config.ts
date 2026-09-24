import 'server-only'
import type { AppConfig } from '@/types'
import { getDb } from './db'

const DEFAULTS: AppConfig = {
  watched_namespaces: [],
  ignored_namespaces: ['kube-system', 'kube-public', 'kube-node-lease'],
  approval_enabled: false,
  approval_required_count: 1,
  approval_default_approvers: [],
  auto_default_deny_enabled: false,
  auto_default_deny_direction: 'ingress',
  auto_default_deny_allow_intra: true,
  auto_default_deny_allow_internet: false,
  auto_default_deny_scope: 'all',
  autosync_enabled: false,
  autosync_interval_s: 60,
  hubble_discovery_enabled: false,
  hubble_flow_retention_days: 7,
  hubble_internet_flow_retention_days: 1,
  backup_enabled: false,
  backup_cron: '0 3 * * *',
  backup_s3_bucket: '',
  backup_s3_prefix: 'floodgate-backups/',
}

function getRow(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM app_config WHERE key = ?').get(key) as { value: string } | undefined
  return row?.value ?? null
}

// A single corrupt app_config row must not break every config read
function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    console.error('[floodgate] valor de config corrompido, usando default:', raw)
    return fallback
  }
}

export function getConfig(): AppConfig {
  return {
    watched_namespaces:           parseJson(getRow('watched_namespaces'), DEFAULTS.watched_namespaces),
    ignored_namespaces:           parseJson(getRow('ignored_namespaces'), DEFAULTS.ignored_namespaces),
    approval_enabled:             parseJson(getRow('approval_enabled'), DEFAULTS.approval_enabled),
    approval_required_count:      parseJson(getRow('approval_required_count'), DEFAULTS.approval_required_count),
    approval_default_approvers:   parseJson(getRow('approval_default_approvers'), DEFAULTS.approval_default_approvers),
    auto_default_deny_enabled:    parseJson(getRow('auto_default_deny_enabled'), DEFAULTS.auto_default_deny_enabled),
    auto_default_deny_direction:  (getRow('auto_default_deny_direction') ?? 'ingress') as AppConfig['auto_default_deny_direction'],
    auto_default_deny_allow_intra:    parseJson(getRow('auto_default_deny_allow_intra'), DEFAULTS.auto_default_deny_allow_intra),
    auto_default_deny_allow_internet: parseJson(getRow('auto_default_deny_allow_internet'), DEFAULTS.auto_default_deny_allow_internet),
    auto_default_deny_scope:          (getRow('auto_default_deny_scope') ?? 'all') as AppConfig['auto_default_deny_scope'],
    autosync_enabled:             parseJson(getRow('autosync_enabled'), DEFAULTS.autosync_enabled),
    autosync_interval_s:          parseJson(getRow('autosync_interval_s'), DEFAULTS.autosync_interval_s),
    hubble_discovery_enabled:     parseJson(getRow('hubble_discovery_enabled'), DEFAULTS.hubble_discovery_enabled),
    hubble_flow_retention_days:   parseJson(getRow('hubble_flow_retention_days'), DEFAULTS.hubble_flow_retention_days),
    hubble_internet_flow_retention_days: parseJson(getRow('hubble_internet_flow_retention_days'), DEFAULTS.hubble_internet_flow_retention_days),
    backup_enabled:               parseJson(getRow('backup_enabled'), DEFAULTS.backup_enabled),
    backup_cron:                  getRow('backup_cron') ?? DEFAULTS.backup_cron,
    backup_s3_bucket:             getRow('backup_s3_bucket') ?? DEFAULTS.backup_s3_bucket,
    backup_s3_prefix:             getRow('backup_s3_prefix') ?? DEFAULTS.backup_s3_prefix,
  }
}

export function setConfig(c: AppConfig): void {
  const db = getDb()
  const upsert = db.prepare('INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)')
  db.transaction(() => {
    upsert.run('watched_namespaces',         JSON.stringify(c.watched_namespaces))
    upsert.run('ignored_namespaces',         JSON.stringify(c.ignored_namespaces))
    upsert.run('approval_enabled',           JSON.stringify(c.approval_enabled))
    upsert.run('approval_required_count',    JSON.stringify(c.approval_required_count))
    upsert.run('approval_default_approvers', JSON.stringify(c.approval_default_approvers ?? []))
    upsert.run('auto_default_deny_enabled',  JSON.stringify(c.auto_default_deny_enabled))
    upsert.run('auto_default_deny_direction', c.auto_default_deny_direction)
    upsert.run('auto_default_deny_allow_intra',    JSON.stringify(c.auto_default_deny_allow_intra ?? true))
    upsert.run('auto_default_deny_allow_internet', JSON.stringify(c.auto_default_deny_allow_internet ?? false))
    upsert.run('auto_default_deny_scope', c.auto_default_deny_scope ?? 'all')
    upsert.run('autosync_enabled',    JSON.stringify(c.autosync_enabled))
    upsert.run('autosync_interval_s', JSON.stringify(c.autosync_interval_s))
    upsert.run('hubble_discovery_enabled',   JSON.stringify(c.hubble_discovery_enabled ?? false))
    upsert.run('hubble_flow_retention_days', JSON.stringify(c.hubble_flow_retention_days ?? 7))
    upsert.run('hubble_internet_flow_retention_days', JSON.stringify(c.hubble_internet_flow_retention_days ?? 1))
    upsert.run('backup_enabled',    JSON.stringify(c.backup_enabled ?? false))
    upsert.run('backup_cron',       c.backup_cron ?? DEFAULTS.backup_cron)
    upsert.run('backup_s3_bucket',  c.backup_s3_bucket ?? '')
    upsert.run('backup_s3_prefix',  c.backup_s3_prefix ?? DEFAULTS.backup_s3_prefix)
  })()
}

// Snapshot of namespaces considered "already existing" when auto-deny's
// scope is switched to future_only. Not part of AppConfig (never returned
// to the client as a normal setting), same treatment as autosync_last_run.
const BASELINE_KEY = 'auto_default_deny_baseline_namespaces'

export function getAutoDefaultDenyBaseline(): string[] {
  return parseJson(getRow(BASELINE_KEY), [])
}

export function setAutoDefaultDenyBaseline(namespaces: string[]): void {
  getDb().prepare('INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)').run(BASELINE_KEY, JSON.stringify(namespaces))
}

export function isNamespaceWatched(namespace: string): boolean {
  const cfg = getConfig()
  if (cfg.ignored_namespaces.includes(namespace)) return false
  if (cfg.watched_namespaces.length > 0) return cfg.watched_namespaces.includes(namespace)
  return true
}
