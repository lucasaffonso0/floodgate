#!/usr/bin/env node
// A fake Hubble Relay: serves observer.Observer/GetFlows over gRPC using the
// same vendored proto floodgate decodes (proto/observer/observer.proto), and
// streams synthetic flows at a configurable rate. Point floodgate at it to
// load-test the real ingestion path (processFlow -> SQLite) without a
// Cilium cluster:
//
//   node scripts/perf/fake-hubble-relay.mjs --rate 2000
//   HUBBLE_RELAY_ADDR=localhost:4245 FLOODGATE_PERF_LOG=1 npm run dev
//   (then turn Descoberta on in the Config tab)
//
// Options (defaults in parentheses):
//   --port (4245)            --host (127.0.0.1)
//   --rate (2000)            flow events per second
//   --namespaces (1000)      --services (5000)   same naming as gen-scale-cluster.mjs
//   --internet-ratio (0.7)   share of events going to an external IP
//   --distinct-ips (20000)   size of the external IP pool (one discovered row per IP)
//   --drop-ratio (0.2)       share of DROPPED verdicts
//   --repeat-ratio (0.5)     share of events reusing a recent connection (exercises the update path)

import path from 'path'
import { fileURLToPath } from 'url'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { parseArgs } from './args.mjs'

const args = parseArgs({
  port: 4245, host: '127.0.0.1', rate: 2000, namespaces: 1000, services: 5000,
  'internet-ratio': 0.7, 'distinct-ips': 20000, 'drop-ratio': 0.2, 'repeat-ratio': 0.5,
})
const RATE = Number(args.rate)
const NS = Number(args.namespaces)
const SVC = Number(args.services)
const INTERNET = Number(args['internet-ratio'])
const IPS = Number(args['distinct-ips'])
const DROP = Number(args['drop-ratio'])
const REPEAT = Number(args['repeat-ratio'])

const PROTO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'proto')
const pkgDef = protoLoader.loadSync(path.join(PROTO_ROOT, 'observer', 'observer.proto'), {
  keepCase: true, longs: String, enums: String, defaults: true, oneofs: true, includeDirs: [PROTO_ROOT],
})
const pkg = grpc.loadPackageDefinition(pkgDef)

const rnd = n => Math.floor(Math.random() * n)
const service = j => ({
  namespace: `scale-ns-${j % NS}`,
  labels: [`k8s:app=svc-${j}`],
  workloads: [{ name: `svc-${j}`, kind: 'Deployment' }],
})
const externalIp = k => `203.${(k >> 16) & 255}.${(k >> 8) & 255}.${k & 255}`

// Recent connections, reused to simulate several flow events of one TCP
// connection (same source port), which floodgate dedups into an UPDATE.
const recent = []
function nextFlow() {
  if (recent.length > 0 && Math.random() < REPEAT) return recent[rnd(recent.length)]
  const src = rnd(SVC)
  const toInternet = Math.random() < INTERNET
  const flow = {
    verdict: Math.random() < DROP ? 'DROPPED' : 'FORWARDED',
    source: service(src),
    destination: toInternet ? { labels: ['reserved:world'] } : service(rnd(SVC)),
    ip: { source: '10.0.0.1', destination: toInternet ? externalIp(rnd(IPS)) : '10.0.0.2' },
    l4: { TCP: { source_port: 32768 + rnd(28000), destination_port: toInternet ? 443 : 8080 } },
  }
  recent.push(flow)
  if (recent.length > 5000) recent.shift()
  return flow
}

let sentTotal = 0
let sentWindow = 0

function getFlows(call) {
  console.log('[fake-relay] client connected')
  const perTick = Math.max(1, Math.round(RATE / 20))
  let paused = false
  const timer = setInterval(() => {
    if (paused) return
    // Writes the whole tick's batch, then waits for 'drain' before the next
    // one if the stream reported backpressure. Stopping at the first false
    // instead capped the rate at a few hundred flows/s regardless of
    // --rate, since gRPC signals backpressure after only a few KB.
    for (let i = 0; i < perTick; i++) {
      const ok = call.write({ flow: nextFlow(), node_name: 'fake-relay', time: { seconds: String(Math.floor(Date.now() / 1000)), nanos: 0 } })
      sentTotal++; sentWindow++
      if (!ok && !paused) { paused = true; call.once('drain', () => { paused = false }) }
    }
  }, 50)
  const stop = () => { clearInterval(timer); console.log('[fake-relay] client disconnected') }
  call.on('cancelled', stop)
  call.on('error', stop)
}

function serverStatus(_call, cb) {
  cb(null, { num_flows: String(sentTotal), max_flows: '0', seen_flows: String(sentTotal), uptime_ns: '0' })
}

const server = new grpc.Server()
server.addService(pkg.observer.Observer.service, { GetFlows: getFlows, ServerStatus: serverStatus })
server.bindAsync(`${args.host}:${args.port}`, grpc.ServerCredentials.createInsecure(), (err, port) => {
  if (err) { console.error(err); process.exit(1) }
  console.log(`[fake-relay] listening on ${args.host}:${port}, target ${RATE} flows/s`)
})

setInterval(() => {
  if (sentWindow > 0) console.log(`[fake-relay] sent ${Math.round(sentWindow / 10)} flows/s (total ${sentTotal})`)
  sentWindow = 0
}, 10_000).unref()
