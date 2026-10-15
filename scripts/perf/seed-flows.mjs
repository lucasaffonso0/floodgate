#!/usr/bin/env node
// Inserts synthetic rows straight into discovered_flows, to load-test the
// read side (API payloads, graph, Descoberta tab) at 20k/50k/100k flows
// without waiting for ingestion. Same naming as gen-scale-cluster.mjs.
//
// The app must have started at least once against this database (so the
// tables exist). Targets the local dev database by default and refuses
// anything under /data unless --force is given, to avoid polluting a real
// deployment.
//
//   node scripts/perf/seed-flows.mjs --count 50000
//   node scripts/perf/seed-flows.mjs --count 50000 --clear     (empties discovered_flows first)
//
// Options (defaults in parentheses):
//   --db (floodgate-dev.db)  --count (50000)
//   --namespaces (1000)      --services (5000)
//   --internet-ratio (0.7)   --drop-ratio (0.2)
//   --clear                  --force

import { createHash } from 'crypto'
import Database from 'better-sqlite3'
import { parseArgs } from './args.mjs'

const args = parseArgs({ db: 'floodgate-dev.db', count: 50000, namespaces: 1000, services: 5000, 'internet-ratio': 0.7, 'drop-ratio': 0.2 })
if (String(args.db).startsWith('/data') && !args.force) {
  console.error(`Refusing to write to ${args.db} without --force (looks like a real deployment).`)
  process.exit(1)
}
const COUNT = Number(args.count)
const NS = Number(args.namespaces)
const SVC = Number(args.services)
const INTERNET = Number(args['internet-ratio'])
const DROP = Number(args['drop-ratio'])

const db = new Database(String(args.db))
db.pragma('journal_mode = WAL')
const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='discovered_flows'").get()
if (!exists) {
  console.error(`No discovered_flows table in ${args.db}. Start the app once against this database first.`)
  process.exit(1)
}
if (args.clear) db.prepare('DELETE FROM discovered_flows').run()

// Same id scheme as hubble.ts flowId(), so rows behave like real ones.
const flowId = (srcNs, src, dstNs, dst, port, proto) =>
  createHash('sha1').update(`${srcNs}|${src}|${dstNs}|${dst}|${port}|${proto}`).digest('hex').slice(0, 16)
const rnd = n => Math.floor(Math.random() * n)

const insert = db.prepare(`
  INSERT INTO discovered_flows (id, src_workload, src_namespace, dst_workload, dst_namespace, dst_port, protocol, verdict, flow_count, has_policy, first_seen, last_seen)
  VALUES (@id, @src_workload, @src_namespace, @dst_workload, @dst_namespace, @dst_port, @protocol, @verdict, @flow_count, 0, @first_seen, @last_seen)
  ON CONFLICT(id) DO NOTHING
`)

// Timestamps inside the last 12h: well within both retention windows
// (internet traffic defaults to 1 day), so the hourly cleanup keeps them.
const now = Date.now()
const HOURS_12 = 12 * 3600 * 1000
let inserted = 0
const batch = db.transaction(n => {
  for (let i = 0; i < n; i++) {
    const s = rnd(SVC)
    const toInternet = Math.random() < INTERNET
    const d = rnd(SVC)
    const row = {
      src_workload: `svc-${s}`, src_namespace: `scale-ns-${s % NS}`,
      dst_workload: toInternet ? `203.${rnd(256)}.${rnd(256)}.${rnd(256)}` : `svc-${d}`,
      dst_namespace: toInternet ? 'internet' : `scale-ns-${d % NS}`,
      dst_port: toInternet ? 443 : 8080, protocol: 'TCP',
      verdict: Math.random() < DROP ? 'DROPPED' : 'FORWARDED',
      flow_count: 1 + rnd(500),
    }
    const firstSeen = now - rnd(HOURS_12)
    const lastSeen = firstSeen + rnd(now - firstSeen + 1)
    row.id = flowId(row.src_namespace, row.src_workload, row.dst_namespace, row.dst_workload, row.dst_port, row.protocol)
    row.first_seen = new Date(firstSeen).toISOString()
    row.last_seen = new Date(lastSeen).toISOString()
    inserted += insert.run(row).changes
  }
})
for (let left = COUNT; left > 0; left -= 5000) batch(Math.min(5000, left))

const total = db.prepare('SELECT COUNT(*) c FROM discovered_flows').get().c
console.log(`Inserted ${inserted} rows (${COUNT - inserted} id collisions skipped). discovered_flows now has ${total} rows.`)
db.close()
