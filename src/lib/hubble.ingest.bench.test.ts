import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Ingestion throughput benchmark, skipped in the normal suite. Feeds
// synthetic Hubble messages through the real processFlow() into a real
// on-disk SQLite created by db.ts itself (same schema and pragmas as the
// app, so fsync cost is included), and reports how long the event loop
// was busy. Run with:
//   FLOODGATE_BENCH=1 npx vitest run src/lib/hubble.ingest.bench.test.ts
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'floodgate-bench-')), 'bench.db')
vi.mock('server-only', () => ({}))
vi.mock('./k8s', () => ({ listNetworkPolicies: vi.fn(async () => []), checkHubbleRelayReady: vi.fn(), listServices: vi.fn(async () => []) }))
vi.mock('./config', () => ({ getConfig: () => ({ ignored_namespaces: [], hubble_flow_retention_days: 7, hubble_internet_flow_retention_days: 1 }) }))
vi.mock('./sse', () => ({ emit: vi.fn() }))

const EVENTS = 20_000

describe.skipIf(!process.env.FLOODGATE_BENCH)('hubble ingestion benchmark', () => {
  it(`processes ${EVENTS} flow events`, async () => {
    const { __testing, flushFlowWrites } = await import('./hubble') as typeof import('./hubble') & { flushFlowWrites?: () => void }
    const { getDb } = await import('./db')
    let state = 7
    // mulberry32: a deterministic PRNG with well-mixed low bits (a plain LCG
    // alternates its lowest bit and degenerates on small moduli like rnd(2)).
    const rnd = (n: number) => {
      state = (state + 0x6D2B79F5) | 0
      let t = Math.imul(state ^ (state >>> 15), 1 | state)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) % n
    }
    const svc = (j: number) => ({ namespace: `ns-${j % 50}`, labels: [`k8s:app=svc-${j}`], workloads: [{ name: `svc-${j}`, kind: 'Deployment' }] })
    const recent: unknown[] = []
    const next = () => {
      if (recent.length && rnd(2) === 0) return recent[rnd(recent.length)]
      const toInternet = rnd(10) < 7
      const msg = { flow: {
        verdict: rnd(5) === 0 ? 'DROPPED' : 'FORWARDED',
        source: svc(rnd(500)),
        destination: toInternet ? { labels: ['reserved:world'] } : svc(rnd(500)),
        ip: { source: '10.0.0.1', destination: toInternet ? `203.0.${rnd(256)}.${rnd(256)}` : '10.0.0.2' },
        l4: { TCP: { source_port: 32768 + rnd(28000), destination_port: toInternet ? 443 : 8080 } },
      } }
      recent.push(msg); if (recent.length > 2000) recent.shift()
      return msg
    }
    const t0 = performance.now()
    for (let i = 0; i < EVENTS; i++) __testing.processFlow(next())
    flushFlowWrites?.()
    const ms = performance.now() - t0
    const rows = (getDb().prepare('SELECT COUNT(*) c FROM discovered_flows').get() as { c: number }).c
    console.log('[bench] counters', JSON.stringify(Object.fromEntries((global as unknown as { _floodgatePerfCounters?: Map<string, number> })._floodgatePerfCounters ?? new Map())))
    console.log(`[bench] ${EVENTS} events in ${ms.toFixed(0)} ms (${(EVENTS / (ms / 1000)).toFixed(0)} events/s of main-thread time), ${rows} rows`)
    expect(rows).toBeGreaterThan(0)
  }, 120_000)
})
