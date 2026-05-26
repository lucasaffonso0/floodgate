import 'server-only'
import path from 'path'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { createHash } from 'crypto'
import { getDb } from './db'
import { listNetworkPolicies, checkHubbleRelayReady, listServices } from './k8s'
import { getConfig } from './config'
import { emit } from './sse'
import type { CiliumFlowSummary } from '@/types'

const PROTO_ROOT = path.join(process.cwd(), 'proto')
const HUBBLE_ADDR = process.env.HUBBLE_RELAY_ADDR ?? 'hubble-relay.kube-system.svc.cluster.local:80'

type ObserverClient = grpc.Client & {
  GetFlows: (req: unknown, meta: grpc.Metadata) => grpc.ClientReadableStream<unknown>
}

function loadClient(): ObserverClient {
  const pkgDef = protoLoader.loadSync(
    path.join(PROTO_ROOT, 'observer', 'observer.proto'),
    { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true, includeDirs: [PROTO_ROOT] }
  )
  const pkg = grpc.loadPackageDefinition(pkgDef) as Record<string, unknown>
  const ObserverService = (pkg['observer'] as Record<string, unknown>)['Observer'] as typeof grpc.Client
  return new ObserverService(HUBBLE_ADDR, grpc.credentials.createInsecure()) as ObserverClient
}

function flowId(src_ns: string, src: string, dst_ns: string, dst: string, port: number, proto: string): string {
  return createHash('sha1').update(`${src_ns}|${src}|${dst_ns}|${dst}|${port}|${proto}`).digest('hex').slice(0, 16)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractEndpoint(ep: any): { workload: string; namespace: string } {
  const namespace: string = ep?.namespace ?? ''
  const workloads: Array<{ name?: string; kind?: string }> = ep?.workloads ?? []
  const labels: string[] = ep?.labels ?? []

  let workload = workloads[0]?.name ?? ep?.pod_name ?? ''
  if (!workload) {
    const appLabel = labels.find((l: string) => /^(k8s:)?app=/.test(l))
    workload = appLabel?.replace(/^(k8s:)?app=/, '') ?? ''
  }
  return { workload, namespace }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractPort(l4: any): { port: number; protocol: 'TCP' | 'UDP' } | null {
  if (l4?.TCP) return { port: Number(l4.TCP.destination_port), protocol: 'TCP' }
  if (l4?.UDP) return { port: Number(l4.UDP.destination_port), protocol: 'UDP' }
  return null
}

// ─── Cache de ports dos K8s Services (filtra portas efêmeras vs. portas reais) ──
// key: "namespace::serviceName" → Set de target_ports declarados no Service
let _svcPortCache = new Map<string, Set<number>>()
let _svcPortCacheAt = 0
let _svcPortCacheRefreshing = false

async function refreshSvcPortCache(): Promise<void> {
  if (_svcPortCacheRefreshing) return
  _svcPortCacheRefreshing = true
  try {
    const services = await listServices()
    const cache = new Map<string, Set<number>>()
    for (const svc of services) {
      const key = `${svc.namespace}::${svc.name}`
      if (!cache.has(key)) cache.set(key, new Set())
      for (const p of svc.ports) {
        cache.get(key)!.add(p.port)
        if (p.target_port) cache.get(key)!.add(p.target_port)
      }
    }
    _svcPortCache = cache
    _svcPortCacheAt = Date.now()
  } catch { /* non-critical — mantém cache antigo */ }
  finally { _svcPortCacheRefreshing = false }
}

function isKnownServicePort(namespace: string, workload: string, port: number): boolean {
  const directKey = `${namespace}::${workload}`
  if (_svcPortCache.get(directKey)?.has(port)) return true
  // Prefix match: workload pode ser nome de pod como "haproxy-abc12-xyz99", service é "haproxy"
  for (const [k, ports] of _svcPortCache) {
    if (!k.startsWith(`${namespace}::`)) continue
    const svcName = k.slice(namespace.length + 2)
    if (workload.startsWith(svcName + '-') || workload.startsWith(svcName + '_')) {
      if (ports.has(port)) return true
    }
  }
  return false
}

// ─── Cache de namespaces ignorados (evita leitura de DB em cada flow) ─────
let _ignoredNsCache: string[] = []
let _ignoredNsCacheAt = 0
function getIgnoredNamespaces(): string[] {
  if (Date.now() - _ignoredNsCacheAt > 10_000) {
    _ignoredNsCache = getConfig().ignored_namespaces
    _ignoredNsCacheAt = Date.now()
  }
  return _ignoredNsCache
}

// ─── Deduplicação por conexão TCP (source port identifica cada conexão única) ──
// key: "flowId:srcPort" → timestamp de primeiro avistamento (para limpeza TTL)
const _connDedup = new Map<string, number>()
const CONN_TTL_MS = 120_000  // remove entradas após 2 min (porta efêmera não será reutilizada tão cedo)

function isNewConnection(id: string, srcPort: number): boolean {
  if (srcPort === 0) return true  // campo não preenchido → não deduplica
  const key = `${id}:${srcPort}`
  if (_connDedup.has(key)) return false
  _connDedup.set(key, Date.now())
  // Limpeza periódica para não crescer indefinidamente
  if (_connDedup.size > 20_000) {
    const cutoff = Date.now() - CONN_TTL_MS
    for (const [k, ts] of _connDedup) { if (ts < cutoff) _connDedup.delete(k) }
  }
  return true
}

// ─── Global streaming state ────────────────────────────────────────────────
const g = global as typeof global & {
  _hubbleClient?: ObserverClient
  _hubbleStream?: grpc.ClientReadableStream<unknown>
  _hubbleStreaming?: boolean
  _hubbleRetryTimer?: ReturnType<typeof setTimeout>
  _hubbleLastSseEmit?: number
}

export function isHubbleStreaming(): boolean {
  return g._hubbleStreaming === true
}

// ─── Process individual flow from stream ──────────────────────────────────
function processFlow(msg: unknown): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const flow = (msg as any)?.flow
  if (!flow) return
  if (flow.is_reply === true) return

  const src = extractEndpoint(flow.source)
  const dst = extractEndpoint(flow.destination)
  const portInfo = extractPort(flow.l4)
  const rawVerdict: string = flow.verdict ?? ''

  if (!src.workload || !portInfo || portInfo.port === 0) return
  if (!dst.workload && !dst.namespace) return
  if (portInfo.port === 53) return
  if (portInfo.port >= 32768) {
    // Porta alta: só aceita se for port declarado em algum K8s Service real do destino.
    // Caso contrário, é porta efêmera de resposta TCP (Hubble captura os dois sentidos).
    if (Date.now() - _svcPortCacheAt > 60_000) refreshSvcPortCache()  // refresh async em background
    if (!isKnownServicePort(dst.namespace, dst.workload, portInfo.port)) return
  }

  const ignored = getIgnoredNamespaces()
  if (ignored.includes(src.namespace) || ignored.includes(dst.namespace)) return

  const verdict = rawVerdict === 'FORWARDED' ? 'FORWARDED'
    : rawVerdict === 'DROPPED' ? 'DROPPED'
    : rawVerdict === 'AUDIT' ? 'AUDIT'
    : null
  if (!verdict) return

  const now = new Date().toISOString()
  const dstWorkload = dst.workload || `${dst.namespace}/unknown`
  const id = flowId(src.namespace, src.workload, dst.namespace, dstWorkload, portInfo.port, portInfo.protocol)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const srcPort: number = Number((flow.l4 as any)?.TCP?.source_port ?? (flow.l4 as any)?.UDP?.source_port ?? 0)
  const isNew = isNewConnection(id, srcPort)

  try {
    if (isNew) {
      getDb().prepare(`
        INSERT INTO discovered_flows (id, src_workload, src_namespace, dst_workload, dst_namespace, dst_port, protocol, verdict, flow_count, has_policy, first_seen, last_seen)
        VALUES (@id, @src_workload, @src_namespace, @dst_workload, @dst_namespace, @dst_port, @protocol, @verdict, 1, 0, @now, @now)
        ON CONFLICT(id) DO UPDATE SET
          flow_count = discovered_flows.flow_count + 1,
          verdict = excluded.verdict,
          last_seen = excluded.last_seen
      `).run({ id, src_workload: src.workload, src_namespace: src.namespace, dst_workload: dstWorkload, dst_namespace: dst.namespace, dst_port: portInfo.port, protocol: portInfo.protocol, verdict, now })
    } else {
      getDb().prepare(`UPDATE discovered_flows SET verdict = ?, last_seen = ? WHERE id = ?`).run(verdict, now, id)
    }

    // Emit SSE no máximo a cada 3s para não sobrecarregar o frontend
    const lastEmit = g._hubbleLastSseEmit ?? 0
    if (Date.now() - lastEmit > 3000) {
      g._hubbleLastSseEmit = Date.now()
      emit({ type: 'hubble_flow_new' })
    }
  } catch (e) {
    console.error('[hubble] DB write error:', e)
  }
}

// ─── Start / stop stream ───────────────────────────────────────────────────
export function startHubbleStream(): void {
  if (g._hubbleStreaming) return
  if (g._hubbleRetryTimer) { clearTimeout(g._hubbleRetryTimer); g._hubbleRetryTimer = undefined }

  console.log('[hubble] starting real-time stream')
  g._hubbleStreaming = true
  refreshSvcPortCache()  // popula cache de ports antes dos primeiros flows

  try {
    const client = loadClient()
    g._hubbleClient = client
    const stream = client.GetFlows({ number: '0', follow: true }, new grpc.Metadata())
    g._hubbleStream = stream

    stream.on('data', processFlow)

    stream.on('error', (err: Error) => {
      console.error('[hubble] stream error:', err.message)
      g._hubbleStreaming = false
      g._hubbleStream = undefined
      g._hubbleClient?.close()
      g._hubbleClient = undefined
      // Auto-reconecta se ainda estiver ativado
      g._hubbleRetryTimer = setTimeout(() => {
        g._hubbleRetryTimer = undefined
        const val = (getDb().prepare("SELECT value FROM app_config WHERE key = 'hubble_discovery_enabled'").get() as { value: string } | undefined)?.value
        if (val === 'true') startHubbleStream()
      }, 15_000)
    })

    stream.on('end', () => {
      console.log('[hubble] stream ended')
      g._hubbleStreaming = false
      g._hubbleStream = undefined
      g._hubbleClient?.close()
      g._hubbleClient = undefined
    })
  } catch (e) {
    console.error('[hubble] failed to start stream:', e)
    g._hubbleStreaming = false
  }
}

export function stopHubbleStream(): void {
  if (g._hubbleRetryTimer) { clearTimeout(g._hubbleRetryTimer); g._hubbleRetryTimer = undefined }
  g._hubbleStream?.destroy()
  g._hubbleClient?.close()
  g._hubbleStream = undefined
  g._hubbleClient = undefined
  g._hubbleStreaming = false
  console.log('[hubble] stream stopped')
}

// ─── Atualiza has_policy para todos os flows (chamado pelo scheduler) ──────
export async function updateFlowPolicies(): Promise<void> {
  try {
    const db = getDb()
    const count = (db.prepare('SELECT COUNT(*) as c FROM discovered_flows').get() as { c: number }).c
    if (count === 0) return

    const allPolicies = await listNetworkPolicies(true).catch(() => [])
    if (allPolicies.length === 0) return

    const flows = db.prepare('SELECT id, dst_workload, dst_namespace, dst_port FROM discovered_flows').all() as Array<{ id: string; dst_workload: string; dst_namespace: string; dst_port: number }>
    const updateStmt = db.prepare('UPDATE discovered_flows SET has_policy = ? WHERE id = ?')
    db.transaction(() => {
      for (const f of flows) {
        const has = allPolicies.some(p =>
          p.namespace === f.dst_namespace && (
            (p.dst_service === f.dst_workload && (p.dst_ports.some(ps => ps.port === f.dst_port) || p.dst_port === f.dst_port)) ||
            (p.namespace === f.dst_namespace && (p.policy_type === 'restrict-ingress' || p.policy_type === 'restrict-egress'))
          )
        )
        updateStmt.run(has ? 1 : 0, f.id)
      }
    })()
  } catch { /* non-critical */ }
}

// ─── Limpeza de flows antigos ──────────────────────────────────────────────
export function runRetentionCleanup(): void {
  try {
    const retentionDays = getConfig().hubble_flow_retention_days ?? 7
    const staleDate = new Date(Date.now() - retentionDays * 86400 * 1000).toISOString()
    getDb().prepare('DELETE FROM discovered_flows WHERE last_seen < ?').run(staleDate)
  } catch { /* non-critical */ }
}

// ─── API pública ───────────────────────────────────────────────────────────
export async function checkHubbleAvailable(): Promise<boolean> {
  return checkHubbleRelayReady()
}

export function getDiscoveredFlows(): CiliumFlowSummary[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM discovered_flows ORDER BY flow_count DESC').all() as Array<Record<string, unknown>>
  return rows.map(r => ({
    id: r.id as string,
    src_workload: r.src_workload as string,
    src_namespace: r.src_namespace as string,
    dst_workload: r.dst_workload as string,
    dst_namespace: r.dst_namespace as string,
    dst_port: r.dst_port as number,
    protocol: r.protocol as 'TCP' | 'UDP',
    verdict: r.verdict as CiliumFlowSummary['verdict'],
    flow_count: r.flow_count as number,
    has_policy: Boolean(r.has_policy),
    first_seen: r.first_seen as string,
    last_seen: r.last_seen as string,
  }))
}

export function clearDiscoveredFlows(): void {
  getDb().prepare('DELETE FROM discovered_flows').run()
}
