import 'server-only'
import { getDb } from './db'
import { checkDrift, runAutosync } from './autosync'
import { startHubbleStream, stopHubbleStream, isHubbleStreaming, updateFlowPolicies, runRetentionCleanup, normalizeStoredFlows } from './hubble'
import { runBackup, nextBackupFireTime, readLastBackupRun, saveLastBackupRun } from './backup'
import { getWriteMode } from './writeMode'
import { refreshRepoInBackground } from './git'
import { clearAllPendingOps, expireStalePendingOps } from './gitopsPendingOps'

const TICK_MS = 15_000
// Cleanup de retenção uma vez por hora
let lastRetentionCleanup = 0
// Fetch em background do repositório GitOps (não a cada 15s: reintroduziria
// o custo de rede que a separação leitura/escrita eliminou) e expiração de
// gitops_pending_ops travado, a cada tick (barato: só uma comparação de data).
const GIT_BACKGROUND_REFRESH_MS = 180_000
const GITOPS_PENDING_OP_MAX_AGE_MINUTES = 5
let lastGitBackgroundRefresh = 0

function readConfig(): { enabled: boolean; interval_s: number } {
  try {
    const db = getDb()
    const get = (key: string) =>
      (db.prepare('SELECT value FROM app_config WHERE key = ?').get(key) as { value: string } | undefined)?.value
    return {
      enabled:    JSON.parse(get('autosync_enabled')    ?? 'false'),
      interval_s: JSON.parse(get('autosync_interval_s') ?? '60'),
    }
  } catch {
    return { enabled: false, interval_s: 60 }
  }
}

function readBackupConfig(): { enabled: boolean; cron: string } {
  try {
    const db = getDb()
    const get = (key: string) =>
      (db.prepare('SELECT value FROM app_config WHERE key = ?').get(key) as { value: string } | undefined)?.value
    return {
      enabled: JSON.parse(get('backup_enabled') ?? 'false'),
      cron:    get('backup_cron') ?? '0 3 * * *',
    }
  } catch {
    return { enabled: false, cron: '0 3 * * *' }
  }
}

function readHubbleEnabled(): boolean {
  try {
    const val = (getDb().prepare("SELECT value FROM app_config WHERE key = 'hubble_discovery_enabled'").get() as { value: string } | undefined)?.value
    return JSON.parse(val ?? 'false')
  } catch {
    return false
  }
}

function readLastRun(): number {
  try {
    const val = (getDb().prepare('SELECT value FROM app_config WHERE key = ?').get('autosync_last_run') as { value: string } | undefined)?.value
    return val ? JSON.parse(val) : 0
  } catch { return 0 }
}

function saveLastRun(ts: number): void {
  try {
    getDb().prepare('INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)').run('autosync_last_run', JSON.stringify(ts))
  } catch { /* non-critical */ }
}

const g = global as typeof global & {
  _floodgateSchedulerStarted?: boolean
  _floodgateLastAutosync?: number
  _floodgateLastBackup?: number
}

async function tick() {
  try {
    const { enabled, interval_s } = readConfig()

    await checkDrift()

    if (enabled) {
      const last = g._floodgateLastAutosync ?? 0
      if (Date.now() - last >= interval_s * 1000) {
        g._floodgateLastAutosync = Date.now()
        saveLastRun(g._floodgateLastAutosync)
        await runAutosync()
      }
    }

    // Backup: positional (cron), not "every N seconds since last run" like
    // autosync. The next fire time is recomputed from the persisted last
    // run every tick, which is cheap and survives pod restarts.
    const { enabled: backupEnabled, cron: backupCron } = readBackupConfig()
    if (backupEnabled) {
      try {
        const lastBackup = g._floodgateLastBackup ?? readLastBackupRun()
        const nextFire = nextBackupFireTime(backupCron, lastBackup)
        if (Date.now() >= nextFire) {
          g._floodgateLastBackup = Date.now()
          saveLastBackupRun(g._floodgateLastBackup)
          await runBackup()
        }
      } catch (e) {
        console.error('[backup] expressão cron inválida ou falha ao agendar:', e)
      }
    }

    // Hubble streaming
    const hubbleEnabled = readHubbleEnabled()
    if (hubbleEnabled) {
      if (!isHubbleStreaming()) startHubbleStream()
      normalizeStoredFlows()
      await updateFlowPolicies()
      if (Date.now() - lastRetentionCleanup > 3_600_000) {
        lastRetentionCleanup = Date.now()
        runRetentionCleanup()
      }
    } else {
      if (isHubbleStreaming()) stopHubbleStream()
    }

    if (getWriteMode() === 'gitops') {
      // Cheap every tick: just a date comparison against gitops_pending_ops.
      expireStalePendingOps(GITOPS_PENDING_OP_MAX_AGE_MINUTES)
      // The actual fetch+reset only on its own longer interval: doing this
      // every 15s would reintroduce the network cost the read/write lock
      // split was built to eliminate. Fire-and-forget: a slow/unreachable
      // repo here must never hold up the rest of this tick (autosync,
      // backup, hubble), which is why refreshRepoInBackground() itself
      // already catches and logs instead of throwing.
      if (Date.now() - lastGitBackgroundRefresh >= GIT_BACKGROUND_REFRESH_MS) {
        lastGitBackgroundRefresh = Date.now()
        refreshRepoInBackground().catch(() => {})
      }
    }
  } catch (e) {
    console.error('[scheduler] tick error:', e)
  }
}

if (!g._floodgateSchedulerStarted) {
  g._floodgateSchedulerStarted = true
  g._floodgateLastAutosync = readLastRun()
  g._floodgateLastBackup = readLastBackupRun()
  // Nada em gitops_pending_ops pode legitimamente sobreviver a um
  // reinício, ver o comentário em gitopsPendingOps.ts.
  clearAllPendingOps()
  setInterval(tick, TICK_MS)
  console.log('[floodgate] background scheduler started')
}
