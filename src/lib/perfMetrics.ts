import 'server-only'
import { monitorEventLoopDelay } from 'perf_hooks'

// Opt-in performance telemetry for measuring the app under load (see
// scripts/perf/). Counters are always incremented (a Map increment is
// negligible); only the periodic log line and the event-loop histogram are
// gated on FLOODGATE_PERF_LOG=1, so production stays quiet by default.
const LOG_INTERVAL_MS = 60_000

const g = global as typeof global & {
  _floodgatePerfCounters?: Map<string, number>
  _floodgatePerfStarted?: boolean
}

function counters(): Map<string, number> {
  if (!g._floodgatePerfCounters) g._floodgatePerfCounters = new Map()
  return g._floodgatePerfCounters
}

export function perfCount(name: string, by = 1): void {
  const c = counters()
  c.set(name, (c.get(name) ?? 0) + by)
}

export function isPerfLogEnabled(): boolean {
  return process.env.FLOODGATE_PERF_LOG === '1'
}

// Called once from the scheduler's startup block. Each log line covers the
// interval since the previous one: counters are reported as deltas and
// reset, the event-loop histogram is reset after every read.
export function startPerfLogging(): void {
  if (!isPerfLogEnabled() || g._floodgatePerfStarted) return
  g._floodgatePerfStarted = true

  const loop = monitorEventLoopDelay({ resolution: 10 })
  loop.enable()

  setInterval(() => {
    const ms = (ns: number) => Math.round(ns / 1e6)
    const mem = process.memoryUsage()
    const snapshot = Object.fromEntries([...counters().entries()].sort(([a], [b]) => a.localeCompare(b)))
    counters().clear()
    console.log('[perf]', JSON.stringify({
      interval_s: LOG_INTERVAL_MS / 1000,
      event_loop_ms: { p50: ms(loop.percentile(50)), p99: ms(loop.percentile(99)), max: ms(loop.max) },
      memory_mb: { rss: Math.round(mem.rss / 1048576), heap_used: Math.round(mem.heapUsed / 1048576) },
      counters: snapshot,
    }))
    loop.reset()
  }, LOG_INTERVAL_MS).unref()

  console.log('[perf] logging enabled (FLOODGATE_PERF_LOG=1)')
}
