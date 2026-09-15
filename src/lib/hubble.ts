import 'server-only'
import path from 'path'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { createHash } from 'crypto'
import { getDb } from './db'
import { listNetworkPolicies, checkHubbleRelayReady, listServices } from './k8s'
import { getConfig } from './config'
import { emit } from './sse'
import type { CiliumFlowSummary, NetworkPolicyInfo } from '@/types'

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

// Strips the ReplicaSet/StatefulSet pod suffix (-<hash10>-<hash5> or -<hash5>)
// so a raw pod name matches the clean workload name stored on policy labels.
function normalizeWorkload(workload: string): string {
  return workload
    .replace(/-[a-z0-9]{5,10}-[a-z0-9]{5}$/, '')
    .replace(/-[a-z0-9]{5}$/, '')
}

// Only an ALLOW-type policy that covers this exact src → dst:port means
// "nothing to create here" — a restrict-ingress/egress anywhere in the
// namespace is why traffic gets dropped in the first place, and an allow
// that covers a *different* source doesn't cover this one. Shared by the
// insert-time classification and the periodic recompute so they never drift.
function flowHasPolicy(
  f: { src_workload: string; src_namespace: string; dst_workload: string; dst_namespace: string; dst_port: number },
  policies: NetworkPolicyInfo[],
): boolean {
  const srcWorkload = normalizeWorkload(f.src_workload)
  return policies.some(p => {
    if (p.namespace !== f.dst_namespace || p.dst_service !== f.dst_workload) return false
    const portMatches = p.dst_ports.some(ps => ps.port === f.dst_port) || p.dst_port === f.dst_port
    if (!portMatches) return false
    if (p.policy_type === 'allow') return p.src_workload === srcWorkload && p.src_namespace === f.src_namespace
    if (p.policy_type === 'allow-namespace') return p.src_namespace === f.src_namespace
    return false
  })
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractEndpoint(ep: any): { workload: string; namespace: string } {
  const namespace: string = ep?.namespace ?? ''
  const workloads: Array<{ name?: string; kind?: string }> = ep?.workloads ?? []
  const labels: string[] = ep?.labels ?? []

  // Cilium hasn't always resolved the owner workload (e.g. right after a pod
  // starts) and falls back to the raw pod name — normalize either way so the
  // same logical service always gets the same identity across flow records
  // (this also fixes duplicate rows for what's really one src→dst pair).
  let workload = workloads[0]?.name ?? ep?.pod_name ?? ''
  if (!workload) {
    const appLabel = labels.find((l: string) => /^(k8s:)?app=/.test(l))
    workload = appLabel?.replace(/^(k8s:)?app=/, '') ?? ''
  }
  return { workload: normalizeWorkload(workload), namespace }
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

// ─── Cache de policies (classifica has_policy já na inserção do flow, sem
// esperar o próximo ciclo do scheduler) ────────────────────────────────────
let _policyCache: NetworkPolicyInfo[] = []
let _policyCacheAt = 0
let _policyCacheRefreshing = false

async function refreshPolicyCache(): Promise<void> {
  if (_policyCacheRefreshing) return
  _policyCacheRefreshing = true
  try {
    _policyCache = await listNetworkPolicies(true)
    _policyCacheAt = Date.now()
  } catch { /* non-critical — mantém cache antigo */ }
  finally { _policyCacheRefreshing = false }
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

  if (Date.now() - _policyCacheAt > 15_000) refreshPolicyCache()  // refresh async em background

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
      const hasPolicy = flowHasPolicy(
        { src_workload: src.workload, src_namespace: src.namespace, dst_workload: dstWorkload, dst_namespace: dst.namespace, dst_port: portInfo.port },
        _policyCache,
      )
      getDb().prepare(`
        INSERT INTO discovered_flows (id, src_workload, src_namespace, dst_workload, dst_namespace, dst_port, protocol, verdict, flow_count, has_policy, first_seen, last_seen)
        VALUES (@id, @src_workload, @src_namespace, @dst_workload, @dst_namespace, @dst_port, @protocol, @verdict, 1, @has_policy, @now, @now)
        ON CONFLICT(id) DO UPDATE SET
          flow_count = discovered_flows.flow_count + 1,
          verdict = excluded.verdict,
          last_seen = excluded.last_seen
      `).run({ id, src_workload: src.workload, src_namespace: src.namespace, dst_workload: dstWorkload, dst_namespace: dst.namespace, dst_port: portInfo.port, protocol: portInfo.protocol, verdict, has_policy: hasPolicy ? 1 : 0, now })
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
  refreshPolicyCache()   // popula cache de policies antes dos primeiros flows

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

    // Fetch fresh rather than trust the cache here — this is the periodic
    // authoritative reconciliation pass, the cache is only for insert-time
    // best-effort classification.
    const allPolicies = await listNetworkPolicies(true).catch(() => [])
    if (allPolicies.length === 0) return
    _policyCache = allPolicies
    _policyCacheAt = Date.now()

    const flows = db.prepare('SELECT id, src_workload, src_namespace, dst_workload, dst_namespace, dst_port FROM discovered_flows').all() as Array<{
      id: string; src_workload: string; src_namespace: string; dst_workload: string; dst_namespace: string; dst_port: number
    }>
    const updateStmt = db.prepare('UPDATE discovered_flows SET has_policy = ? WHERE id = ?')
    db.transaction(() => {
      for (const f of flows) {
        updateStmt.run(flowHasPolicy(f, allPolicies) ? 1 : 0, f.id)
      }
    })()
  } catch { /* non-critical */ }
}

// ─── Normaliza flows já gravados com nome de pod cru (pré-fix) e funde
// duplicatas que passam a colidir no mesmo id depois da normalização ───────
type DiscoveredFlowRow = {
  id: string; src_workload: string; src_namespace: string; dst_workload: string; dst_namespace: string
  dst_port: number; protocol: string; verdict: string; flow_count: number; has_policy: number
  first_seen: string; last_seen: string
}

export function normalizeStoredFlows(): void {
  try {
    const db = getDb()
    const rows = db.prepare('SELECT * FROM discovered_flows').all() as DiscoveredFlowRow[]
    if (rows.length === 0) return

    const dirty = rows.some(r => normalizeWorkload(r.src_workload) !== r.src_workload || normalizeWorkload(r.dst_workload) !== r.dst_workload)
    if (!dirty) return

    const merged = new Map<string, DiscoveredFlowRow>()
    for (const r of rows) {
      const src_workload = normalizeWorkload(r.src_workload)
      const dst_workload = normalizeWorkload(r.dst_workload)
      const id = flowId(r.src_namespace, src_workload, r.dst_namespace, dst_workload, r.dst_port, r.protocol)
      const existing = merged.get(id)
      if (!existing) {
        merged.set(id, { ...r, id, src_workload, dst_workload })
        continue
      }
      existing.flow_count += r.flow_count
      // Don't trust either row's stored has_policy across a merge — it may
      // have been computed under stale data. updateFlowPolicies() recomputes
      // it fresh right after this runs, every tick.
      existing.has_policy = 0
      if (r.first_seen < existing.first_seen) existing.first_seen = r.first_seen
      if (r.last_seen > existing.last_seen) { existing.last_seen = r.last_seen; existing.verdict = r.verdict }
    }

    const del = db.prepare('DELETE FROM discovered_flows')
    const ins = db.prepare(`
      INSERT INTO discovered_flows (id, src_workload, src_namespace, dst_workload, dst_namespace, dst_port, protocol, verdict, flow_count, has_policy, first_seen, last_seen)
      VALUES (@id, @src_workload, @src_namespace, @dst_workload, @dst_namespace, @dst_port, @protocol, @verdict, @flow_count, @has_policy, @first_seen, @last_seen)
    `)
    db.transaction(() => {
      del.run()
      for (const m of merged.values()) ins.run(m)
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
  // Stable order: sorting by flow_count would reshuffle rows (and graph edge
  // curvature, which is assigned by array position) on every poll as active
  // flows accumulate hits at different rates, even though nothing meaningful
  // changed. first_seen only changes when a genuinely new flow appears.
  const rows = db.prepare('SELECT * FROM discovered_flows ORDER BY first_seen DESC, id').all() as Array<Record<string, unknown>>
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
