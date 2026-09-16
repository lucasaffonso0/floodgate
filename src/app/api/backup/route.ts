import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { getConfig } from '@/lib/config'
import { runBackup, getLastBackupResult, nextBackupFireTime, readLastBackupRun, hasS3Credentials } from '@/lib/backup'
import { apiError } from '@/lib/api-helpers'
import { logAudit } from '@/lib/audit'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })
  try {
    const cfg = getConfig()
    let next_run: string | null = null
    if (cfg.backup_enabled) {
      try {
        // If it's never run before (or the computed time already passed —
        // e.g. right after enabling), the next scheduler tick fires it
        // immediately: show "now" instead of a stale/past timestamp.
        const fire = nextBackupFireTime(cfg.backup_cron, readLastBackupRun())
        next_run = new Date(Math.max(fire, Date.now())).toISOString()
      } catch { /* invalid cron, leave null */ }
    }
    return NextResponse.json({
      enabled: cfg.backup_enabled,
      cron: cfg.backup_cron,
      bucket: cfg.backup_s3_bucket,
      prefix: cfg.backup_s3_prefix,
      last_result: getLastBackupResult(),
      next_run,
      credentials_configured: hasS3Credentials(),
    })
  } catch (e) {
    return apiError(e, 'Falha ao consultar status do backup')
  }
}

export async function POST() {
  try {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })
    if (user.role !== 'admin') return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })

    const result = await runBackup()

    if (result.ok) {
      logAudit({
        user_id: user.sub, username: user.username,
        action: 'manual_backup',
        resource_type: 'Backup', resource_name: result.key ?? '', namespace: '',
        details: JSON.stringify({ key: result.key, size: result.size }),
      })
    }

    return NextResponse.json(result, { status: result.ok ? 200 : 500 })
  } catch (e) {
    return apiError(e, 'Falha ao executar backup')
  }
}
