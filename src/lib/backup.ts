import 'server-only'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { CronExpressionParser } from 'cron-parser'
import { getDb } from './db'
import { getConfig } from './config'
import type { BackupResult } from '@/types'

// Backups are scheduled in UTC regardless of the pod's local timezone —
// container timezone isn't guaranteed consistent across dev/kind/prod, and
// SQLite's own datetime('now') columns are already UTC, so this keeps
// "backup_cron" unambiguous no matter where it runs.
const CRON_TZ = 'UTC'

export function nextBackupFireTime(cronExpr: string, fromMs: number): number {
  const interval = CronExpressionParser.parse(cronExpr, { currentDate: new Date(fromMs), tz: CRON_TZ })
  return interval.next().getTime()
}

export function readLastBackupRun(): number {
  try {
    const row = getDb().prepare('SELECT value FROM app_config WHERE key = ?').get('backup_last_run') as { value: string } | undefined
    return row ? JSON.parse(row.value) : 0
  } catch { return 0 }
}

export function saveLastBackupRun(ts: number): void {
  try {
    getDb().prepare('INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)').run('backup_last_run', JSON.stringify(ts))
  } catch { /* non-critical */ }
}

const g = global as typeof global & { _floodgateLastBackupResult?: BackupResult }

export function getLastBackupResult(): BackupResult | null {
  return g._floodgateLastBackupResult ?? null
}

// Lets the UI warn before the admin even tries a backup — without ever
// exposing the actual credential values through the API.
export function hasS3Credentials(): boolean {
  return !!(process.env.S3_ENDPOINT && process.env.S3_REGION && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY)
}

function s3Client(): S3Client {
  const endpoint = process.env.S3_ENDPOINT
  const region = process.env.S3_REGION
  const accessKeyId = process.env.S3_ACCESS_KEY_ID
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY
  if (!endpoint || !region || !accessKeyId || !secretAccessKey) {
    throw new Error('S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID e S3_SECRET_ACCESS_KEY devem estar configurados')
  }
  // Path-style (endpoint/bucket/key) instead of virtual-hosted-style
  // (bucket.endpoint/key): works against any S3-compatible target — DO
  // Spaces, MinIO, IP-based/local endpoints — without relying on wildcard
  // DNS for a per-bucket subdomain.
  return new S3Client({ endpoint, region, credentials: { accessKeyId, secretAccessKey }, forcePathStyle: true })
}

// VACUUM INTO produces a single consistent snapshot file even in WAL mode
// (a raw copy of the main .db file could miss data still sitting in the
// -wal file and would need the -shm/-wal siblings copied alongside it too).
function createSnapshot(): string {
  const tmpPath = path.join(os.tmpdir(), `floodgate-backup-${Date.now()}.db`)
  getDb().prepare('VACUUM INTO ?').run(tmpPath)
  return tmpPath
}

export async function runBackup(): Promise<BackupResult> {
  const cfg = getConfig()
  let tmpPath: string | undefined
  try {
    if (!cfg.backup_s3_bucket) throw new Error('backup_s3_bucket não configurado')

    tmpPath = createSnapshot()
    const size = fs.statSync(tmpPath).size
    const timestamp = new Date().toISOString()
    const key = `${cfg.backup_s3_prefix}floodgate-${timestamp.replace(/[:.]/g, '-')}.db`

    const body = fs.readFileSync(tmpPath)
    await s3Client().send(new PutObjectCommand({
      Bucket: cfg.backup_s3_bucket,
      Key: key,
      Body: body,
      ContentType: 'application/x-sqlite3',
    }))

    const result: BackupResult = { ok: true, key, size, timestamp }
    g._floodgateLastBackupResult = result
    return result
  } catch (e) {
    const result: BackupResult = { ok: false, error: e instanceof Error ? e.message : String(e), timestamp: new Date().toISOString() }
    g._floodgateLastBackupResult = result
    console.error('[backup] falha ao gerar/enviar backup:', e)
    return result
  } finally {
    if (tmpPath) fs.rm(tmpPath, { force: true }, () => {})
  }
}
