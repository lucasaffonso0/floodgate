import 'server-only'
import { getDb } from './db'
import { checkDrift, runAutosync } from './autosync'
import { startHubbleStream, stopHubbleStream, isHubbleStreaming, updateFlowPolicies, runRetentionCleanup } from './hubble'

const TICK_MS = 15_000
// Cleanup de retenção uma vez por hora
let lastRetentionCleanup = 0

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

    // Hubble streaming
    const hubbleEnabled = readHubbleEnabled()
    if (hubbleEnabled) {
      if (!isHubbleStreaming()) startHubbleStream()
      await updateFlowPolicies()
      if (Date.now() - lastRetentionCleanup > 3_600_000) {
        lastRetentionCleanup = Date.now()
        runRetentionCleanup()
      }
    } else {
      if (isHubbleStreaming()) stopHubbleStream()
    }
  } catch (e) {
    console.error('[scheduler] tick error:', e)
  }
}

if (!g._floodgateSchedulerStarted) {
  g._floodgateSchedulerStarted = true
  g._floodgateLastAutosync = readLastRun()
  setInterval(tick, TICK_MS)
  console.log('[floodgate] background scheduler started')
}
