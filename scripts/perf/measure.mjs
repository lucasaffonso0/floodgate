#!/usr/bin/env node
// Simulates N admins running the main page's 15s poll (the same endpoints
// page.tsx refresh() fetches) against a running floodgate, and reports
// latency and payload size per endpoint. Run it before and after each
// performance change to compare.
//
//   node scripts/perf/measure.mjs --password 'secret' --clients 5 --rounds 10
//
// Options (defaults in parentheses):
//   --url (http://localhost:3000)   --user (admin)   --password (required)
//   --clients (5)      concurrent simulated browsers, all polling at once
//   --rounds (10)      polls per client
//   --interval (0)     ms between a client's polls (15000 mimics the real page)

import { parseArgs } from './args.mjs'

const args = parseArgs({ url: 'http://localhost:3000', user: 'admin', clients: 5, rounds: 10, interval: 0 })
if (!args.password || args.password === true) {
  console.error('--password is required')
  process.exit(1)
}
const BASE = String(args.url).replace(/\/$/, '')
const CLIENTS = Number(args.clients)
const ROUNDS = Number(args.rounds)
const INTERVAL = Number(args.interval)

const ENDPOINTS = [
  '/api/services',
  '/api/networkpolicies',
  '/api/networkpolicies?all=true',
  '/api/service-layout',
  '/api/autosync',
  '/api/approval-requests?status=pending',
  '/api/cilium/flows',
]

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: args.user, password: String(args.password) }),
  })
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`)
  const cookie = res.headers.get('set-cookie')?.split(';')[0]
  if (!cookie) throw new Error('login returned no cookie')
  return cookie
}

const samples = new Map(ENDPOINTS.map(e => [e, { ms: [], bytes: [], errors: 0 }]))
const pollMs = []

async function timed(cookie, endpoint) {
  const t0 = performance.now()
  try {
    const res = await fetch(BASE + endpoint, { headers: { cookie } })
    const body = await res.arrayBuffer()
    const s = samples.get(endpoint)
    s.ms.push(performance.now() - t0)
    s.bytes.push(body.byteLength)
    if (!res.ok) s.errors++
  } catch {
    samples.get(endpoint).errors++
  }
}

async function client(cookie) {
  for (let r = 0; r < ROUNDS; r++) {
    const t0 = performance.now()
    await Promise.all(ENDPOINTS.map(e => timed(cookie, e)))
    pollMs.push(performance.now() - t0)
    if (INTERVAL > 0) await new Promise(res => setTimeout(res, INTERVAL))
  }
}

const pct = (arr, p) => {
  if (arr.length === 0) return 0
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
const kb = b => (b / 1024).toFixed(1)

const cookie = await login()
console.log(`${CLIENTS} clients x ${ROUNDS} polls against ${BASE}\n`)
const t0 = performance.now()
await Promise.all(Array.from({ length: CLIENTS }, () => client(cookie)))
const wall = (performance.now() - t0) / 1000

const rows = ENDPOINTS.map(e => {
  const s = samples.get(e)
  return {
    endpoint: e,
    'p50 ms': Math.round(pct(s.ms, 50)),
    'p95 ms': Math.round(pct(s.ms, 95)),
    'max ms': Math.round(Math.max(0, ...s.ms)),
    'avg KB': kb(s.bytes.reduce((a, b) => a + b, 0) / Math.max(1, s.bytes.length)),
    errors: s.errors,
  }
})
console.table(rows)
console.log(`full poll (all endpoints in parallel): p50 ${Math.round(pct(pollMs, 50))} ms, p95 ${Math.round(pct(pollMs, 95))} ms, max ${Math.round(Math.max(0, ...pollMs))} ms`)
console.log(`wall time ${wall.toFixed(1)} s`)
