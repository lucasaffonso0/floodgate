import 'server-only'
import { getDb } from './db'
import { checkDrift, runAutosync } from './autosync'

const TICK_MS = 15_000

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

// Stored on global so it survives module hot-reloads in dev
const g = global as typeof global & {
  _floodgateSchedulerStarted?: boolean
  _floodgateLastAutosync?: number
}

async function tick() {
  try {
    const { enabled, interval_s } = readConfig()

    // Drift check runs on every tick regardless of autosync setting
    await checkDrift()

    // Auto-fix only if autosync is enabled in config
    if (enabled) {
      const last = g._floodgateLastAutosync ?? 0
      if (Date.now() - last >= interval_s * 1000) {
        g._floodgateLastAutosync = Date.now()
        saveLastRun(g._floodgateLastAutosync)
        await runAutosync()
      }
    }
  } catch (e) {
    console.error('[scheduler] tick error:', e)
  }
}

if (!g._floodgateSchedulerStarted) {
  g._floodgateSchedulerStarted = true
  // Restore last run timestamp from DB — survives pod restarts and respects the configured interval
  g._floodgateLastAutosync = readLastRun()
  setInterval(tick, TICK_MS)
  console.log('[floodgate] background scheduler started')
}
