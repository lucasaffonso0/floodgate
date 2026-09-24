import 'server-only'
import path from 'path'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { createHash } from 'crypto'
import { getDb } from './db'
import { listNetworkPolicies, checkHubbleRelayReady, listServices } from './k8s'
import { getConfig } from './config'
import { emit } from './sse'
import { normalizeWorkload, flowHasPolicy, isWorldEndpoint } from './flowMatch'
import type { CiliumFlowSummary, NetworkPolicyInfo } from '@/types'

const PROTO_ROOT = path.join(process.cwd(), 'proto')
const HUBBLE_ADDR = process.env.HUBBLE_RELAY_ADDR ?? 'hubble-relay.kube-system.svc.cluster.local:80'

// Safety net regardless of retention settings: getDiscoveredFlows()/
// getDraftModeFlows() have no other bound, and internet-bound traffic (one
// permanent row per distinct external IP) can outgrow retention faster
// than the hourly cleanup runs. Most-recent-first (see the ORDER BY
// comment below), so this only ever drops the oldest, least-relevant rows.
// This must stay well above real steady-state volume: a real environment
// was observed sitting at 10,429 accumulated rows (all internet-bound)
// under the old uniform 7-day retention, before internet traffic got its
// own much shorter window. The point of this constant is to catch
// pathological growth (e.g. retention cleanup itself failing), not to
// trim normal days; if it starts binding under everyday load, it's set
// too low, not doing its job.
const MAX_FLOW_ROWS = 20_000

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

  // Cilium hasn't always resolved the owner workload (e.g. right after a pod
  // starts) and falls back to the raw pod name: normalize either way so the
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
  } catch { /* non-critical: mantém cache antigo */ }
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
    _policyCache = excludeUnappliedGitOps(await listNetworkPolicies(true))
    _policyCacheAt = Date.now()
  } catch { /* non-critical: mantém cache antigo */ }
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

// Chamado por PUT /api/config quando ignored_namespaces muda: sem isso, um
// flow que chega nos até 10s seguintes ainda usaria a lista antiga (podendo
// gravar em ignored_flows um flow que acabou de ser des-ignorado, bem depois
// de migrateUnignoredFlows já ter rodado pra essa mesma mudança).
export function invalidateIgnoredNamespacesCache(): void {
  _ignoredNsCacheAt = 0
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
  const portInfo = extractPort(flow.l4)
  const rawVerdict: string = flow.verdict ?? ''

  // A destination outside the cluster (reserved:world) resolves to nothing
  // via extractEndpoint(): namespace and workload both come back empty,
  // same as every other unresolvable "reserved:*" identity (host,
  // unmanaged, kube-apiserver, ...). Those stay dropped exactly as before;
  // world is the one case turned into a real row, using the actual
  // destination IP (flow.ip.destination) as its identity, since there's no
  // in-cluster namespace/workload for it to have. dst_namespace='internet'
  // is a sentinel, same spelling already used for the internet-egress
  // companion policy isolateNamespace() creates (unrelated mechanism, kept
  // consistent on purpose).
  const dstIsWorld = isWorldEndpoint(flow.destination?.labels)
  let dst: { workload: string; namespace: string }
  if (dstIsWorld) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dstIp: string = (flow as any).ip?.destination ?? ''
    if (!dstIp) return  // nothing worth showing without an address
    dst = { workload: dstIp, namespace: 'internet' }
  } else {
    dst = extractEndpoint(flow.destination)
  }

  if (!src.workload || !portInfo || portInfo.port === 0) return
  if (!dst.workload && !dst.namespace) return
  if (portInfo.port === 53) return
  if (portInfo.port >= 32768 && !dstIsWorld) {
    // Porta alta: só aceita se for port declarado em algum K8s Service real do destino.
    // Caso contrário, é porta efêmera de resposta TCP (Hubble captura os dois sentidos).
    // Não faz sentido pra internet: não existe "Service" pra validar contra
    // um IP externo, e uma porta alta ali pode perfeitamente ser real (ex:
    // uma API de terceiro respondendo numa porta não-privilegiada).
    if (Date.now() - _svcPortCacheAt > 60_000) refreshSvcPortCache()  // refresh async em background
    if (!isKnownServicePort(dst.namespace, dst.workload, portInfo.port)) return
  }

  // Namespace ignorada não descarta o flow mais: vai pra uma tabela
  // separada (ignored_flows) em vez de discovered_flows, pra não perder o
  // histórico. Se a namespace deixar de ser ignorada depois, esses flows
  // migram pra discovered_flows (ver migrateUnignoredFlows, chamado quando
  // a config muda) em vez de terem sido descartados pra sempre.
  const ignored = getIgnoredNamespaces()
  const table = (ignored.includes(src.namespace) || ignored.includes(dst.namespace)) ? 'ignored_flows' : 'discovered_flows'

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
        INSERT INTO ${table} (id, src_workload, src_namespace, dst_workload, dst_namespace, dst_port, protocol, verdict, flow_count, has_policy, first_seen, last_seen)
        VALUES (@id, @src_workload, @src_namespace, @dst_workload, @dst_namespace, @dst_port, @protocol, @verdict, 1, @has_policy, @now, @now)
        ON CONFLICT(id) DO UPDATE SET
          flow_count = ${table}.flow_count + 1,
          verdict = excluded.verdict,
          last_seen = excluded.last_seen
      `).run({ id, src_workload: src.workload, src_namespace: src.namespace, dst_workload: dstWorkload, dst_namespace: dst.namespace, dst_port: portInfo.port, protocol: portInfo.protocol, verdict, has_policy: hasPolicy ? 1 : 0, now })
    } else {
      getDb().prepare(`UPDATE ${table} SET verdict = ?, last_seen = ? WHERE id = ?`).run(verdict, now, id)
    }

    // Emit SSE no máximo a cada 3s para não sobrecarregar o frontend, só
    // pros visíveis (discovered_flows); flows de namespace ignorada não têm
    // nada pra atualizar na tela agora mesmo.
    if (table === 'discovered_flows') {
      const lastEmit = g._hubbleLastSseEmit ?? 0
      if (Date.now() - lastEmit > 3000) {
        g._hubbleLastSseEmit = Date.now()
        emit({ type: 'hubble_flow_new' })
      }
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

function reclassifyFlowPolicies(table: 'discovered_flows' | 'ignored_flows', allPolicies: NetworkPolicyInfo[]): void {
  const db = getDb()
  const flows = db.prepare(`SELECT id, src_workload, src_namespace, dst_workload, dst_namespace, dst_port FROM ${table}`).all() as Array<{
    id: string; src_workload: string; src_namespace: string; dst_workload: string; dst_namespace: string; dst_port: number
  }>
  if (flows.length === 0) return
  const updateStmt = db.prepare(`UPDATE ${table} SET has_policy = ? WHERE id = ?`)
  db.transaction(() => {
    for (const f of flows) {
      updateStmt.run(flowHasPolicy(f, allPolicies) ? 1 : 0, f.id)
    }
  })()
}

// reclassifyFlowPolicies() is O(flows × policies): checking every flow's
// has_policy against every policy is only ever needed again when the
// policy SET has actually changed since the last tick (policy creation/
// deletion/port-edit are rare admin actions, not something that happens
// every 15s). This fingerprint is a cheap stand-in for "did anything
// relevant change" (only the fields flowHasPolicy()/explainAccess() ever
// look at), so an unrelated field changing (e.g. created_at) never causes
// a false "changed".
let _lastPolicyFingerprint = ''
function policyFingerprint(policies: NetworkPolicyInfo[]): string {
  return policies
    // sync_status included on purpose: a GitOps policy going from
    // 'pending_argocd' to actually live (ArgoCD synced it) doesn't change
    // any of the OTHER fields here, but it's exactly the kind of change
    // that must trigger a reclassification pass: has_policy excludes
    // still-pending policies (see excludeUnappliedGitOps below), so this
    // transition is what flips a flow from "not covered yet" to "covered"
    // in reality, not just on paper.
    .map(p => `${p.namespace}|${p.name}|${p.policy_type}|${p.dst_service}|${p.dst_port}|${JSON.stringify(p.dst_ports)}|${p.src_workload}|${p.src_namespace}|${p.sync_status ?? ''}`)
    .sort()
    .join(';')
}

// has_policy (both the insert-time cache below and the authoritative
// reclassification pass) must reflect whether Cilium is ACTUALLY enforcing
// a covering policy right now, not whether floodgate has committed one to
// git. listNetworkPolicies(true)'s GitOps merge includes synthesized
// 'pending_argocd' entries for policies not yet applied by ArgoCD: without
// this filter, flowHasPolicy() would match against one of those and report
// has_policy=true (hiding "Criar política") while the flow is still being
// dropped for real, for however long ArgoCD's sync interval is.
function excludeUnappliedGitOps(policies: NetworkPolicyInfo[]): NetworkPolicyInfo[] {
  return policies.filter(p => p.sync_status !== 'pending_argocd')
}

// ─── Atualiza has_policy para todos os flows (chamado pelo scheduler) ──────
export async function updateFlowPolicies(): Promise<void> {
  try {
    const db = getDb()
    const count = (db.prepare('SELECT (SELECT COUNT(*) FROM discovered_flows) + (SELECT COUNT(*) FROM ignored_flows) as c').get() as { c: number }).c
    if (count === 0) return

    // Fetch fresh rather than trust the cache here: this is the periodic
    // authoritative reconciliation pass, the cache is only for insert-time
    // best-effort classification.
    const allPolicies = await listNetworkPolicies(true).catch(() => [])
    if (allPolicies.length === 0) return

    // Fingerprint on the UNFILTERED list: sync_status is one of the
    // fingerprinted fields (see policyFingerprint's comment), so a policy
    // going from pending_argocd to actually applied still changes the
    // fingerprint even though every other field stayed the same, and
    // correctly triggers the reclassification pass below.
    const fingerprint = policyFingerprint(allPolicies)

    const applied = excludeUnappliedGitOps(allPolicies)
    _policyCache = applied
    _policyCacheAt = Date.now()

    if (fingerprint === _lastPolicyFingerprint) return
    _lastPolicyFingerprint = fingerprint

    reclassifyFlowPolicies('discovered_flows', applied)
    reclassifyFlowPolicies('ignored_flows', applied)
  } catch { /* non-critical */ }
}

// ─── Normaliza flows já gravados com nome de pod cru (pré-fix) e funde
// duplicatas que passam a colidir no mesmo id depois da normalização ───────
type DiscoveredFlowRow = {
  id: string; src_workload: string; src_namespace: string; dst_workload: string; dst_namespace: string
  dst_port: number; protocol: string; verdict: string; flow_count: number; has_policy: number
  first_seen: string; last_seen: string
}

function normalizeFlowTable(table: 'discovered_flows' | 'ignored_flows'): void {
  const db = getDb()
  const rows = db.prepare(`SELECT * FROM ${table}`).all() as DiscoveredFlowRow[]
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
    // Don't trust either row's stored has_policy across a merge: it may
    // have been computed under stale data. updateFlowPolicies() recomputes
    // it fresh right after this runs, every tick.
    existing.has_policy = 0
    if (r.first_seen < existing.first_seen) existing.first_seen = r.first_seen
    if (r.last_seen > existing.last_seen) { existing.last_seen = r.last_seen; existing.verdict = r.verdict }
  }

  const del = db.prepare(`DELETE FROM ${table}`)
  const ins = db.prepare(`
    INSERT INTO ${table} (id, src_workload, src_namespace, dst_workload, dst_namespace, dst_port, protocol, verdict, flow_count, has_policy, first_seen, last_seen)
    VALUES (@id, @src_workload, @src_namespace, @dst_workload, @dst_namespace, @dst_port, @protocol, @verdict, @flow_count, @has_policy, @first_seen, @last_seen)
  `)
  db.transaction(() => {
    del.run()
    for (const m of merged.values()) ins.run(m)
  })()
}

// extractEndpoint() (above) always normalizes a workload before it's ever
// written to a row, so a "dirty" row (needing the merge normalizeFlowTable
// does) can only be historical data written before that normalization
// existed in the code, not something that can recur going forward. The
// scheduler used to call this every 15s tick regardless, meaning a full
// `SELECT *` scan of both flow tables just to evaluate the `dirty` check,
// every tick, forever. Once per process lifetime is enough.
let _normalizedStoredFlowsOnce = false
export function normalizeStoredFlows(): void {
  if (_normalizedStoredFlowsOnce) return
  _normalizedStoredFlowsOnce = true
  try {
    normalizeFlowTable('discovered_flows')
    normalizeFlowTable('ignored_flows')
  } catch { /* non-critical */ }
}

// ─── Limpeza de flows antigos ──────────────────────────────────────────────
// Internet-bound flows get their own, much shorter retention window: each
// distinct external IP is a permanent row (no service-identity collapsing
// like in-cluster traffic has), so this is the main source of unbounded
// row growth: see hubble_internet_flow_retention_days in AppConfig.
export function runRetentionCleanup(): void {
  try {
    const cfg = getConfig()
    const staleDate = new Date(Date.now() - (cfg.hubble_flow_retention_days ?? 7) * 86400 * 1000).toISOString()
    const staleInternetDate = new Date(Date.now() - (cfg.hubble_internet_flow_retention_days ?? 1) * 86400 * 1000).toISOString()
    const db = getDb()
    for (const table of ['discovered_flows', 'ignored_flows'] as const) {
      db.prepare(`DELETE FROM ${table} WHERE dst_namespace != 'internet' AND last_seen < ?`).run(staleDate)
      db.prepare(`DELETE FROM ${table} WHERE dst_namespace = 'internet' AND last_seen < ?`).run(staleInternetDate)
    }
  } catch { /* non-critical */ }
}

// ─── Migra de volta pra discovered_flows os flows de uma namespace que
// deixou de ser ignorada (chamado por PUT /api/config quando a lista de
// ignored_namespaces perde alguma entrada) ─────────────────────────────────
export function migrateUnignoredFlows(newIgnoredNamespaces: string[]): void {
  try {
    const db = getDb()
    const rows = db.prepare('SELECT * FROM ignored_flows').all() as DiscoveredFlowRow[]
    if (rows.length === 0) return

    const stillIgnored = new Set(newIgnoredNamespaces)
    // Só migra quem não tem NENHUM dos dois lados ainda ignorado: um flow
    // entre duas namespaces ignoradas continua escondido até as duas saírem
    // da lista.
    const toMigrate = rows.filter(r => !stillIgnored.has(r.src_namespace) && !stillIgnored.has(r.dst_namespace))
    if (toMigrate.length === 0) return

    const upsert = db.prepare(`
      INSERT INTO discovered_flows (id, src_workload, src_namespace, dst_workload, dst_namespace, dst_port, protocol, verdict, flow_count, has_policy, first_seen, last_seen)
      VALUES (@id, @src_workload, @src_namespace, @dst_workload, @dst_namespace, @dst_port, @protocol, @verdict, @flow_count, @has_policy, @first_seen, @last_seen)
      ON CONFLICT(id) DO UPDATE SET
        flow_count = discovered_flows.flow_count + excluded.flow_count,
        verdict = excluded.verdict,
        last_seen = CASE WHEN excluded.last_seen > discovered_flows.last_seen THEN excluded.last_seen ELSE discovered_flows.last_seen END,
        first_seen = CASE WHEN excluded.first_seen < discovered_flows.first_seen THEN excluded.first_seen ELSE discovered_flows.first_seen END
    `)
    const del = db.prepare('DELETE FROM ignored_flows WHERE id = ?')
    db.transaction(() => {
      for (const r of toMigrate) {
        upsert.run(r)
        del.run(r.id)
      }
    })()
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
  const rows = db.prepare('SELECT * FROM discovered_flows ORDER BY first_seen DESC, id LIMIT ?').all(MAX_FLOW_ROWS) as Array<Record<string, unknown>>
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
  const db = getDb()
  db.prepare('DELETE FROM discovered_flows').run()
  db.prepare('DELETE FROM ignored_flows').run()
}

// ── Modo Rascunho ────────────────────────────────────────────────────────
// A frozen copy of discovered_flows, taken once when Modo Rascunho turns
// on: the fixed baseline drafts are compared against. Never written back
// into discovered_flows: live Hubble ingestion keeps running untouched.
export function snapshotFlowsForDraftMode(): void {
  const db = getDb()
  db.exec('DELETE FROM draft_mode_flows')
  db.exec('INSERT INTO draft_mode_flows SELECT * FROM discovered_flows')
}

export function getDraftModeFlows(): CiliumFlowSummary[] {
  const rows = getDb().prepare('SELECT * FROM draft_mode_flows ORDER BY first_seen DESC, id LIMIT ?').all(MAX_FLOW_ROWS) as Array<Record<string, unknown>>
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

export function clearDraftModeFlows(): void {
  getDb().prepare('DELETE FROM draft_mode_flows').run()
}

// Own flag in app_config, not part of AppConfig (same treatment as
// autosync_last_run): can't infer "active" from the snapshot being
// non-empty, since an empty discovered_flows table at activation time
// would look identical to "never activated".
const DRAFT_MODE_KEY = 'draft_mode_active'

export function isDraftModeActive(): boolean {
  const row = getDb().prepare('SELECT value FROM app_config WHERE key = ?').get(DRAFT_MODE_KEY) as { value: string } | undefined
  return row?.value === 'true'
}

export function setDraftModeActive(active: boolean): void {
  getDb().prepare('INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)').run(DRAFT_MODE_KEY, JSON.stringify(active))
}

// Exported for unit tests only: the pure helpers behind the has_policy /
// reclassification fix (excludeUnappliedGitOps, the sync_status-aware
// fingerprint), tested in isolation from the gRPC stream / DB side effects
// the rest of this file has. Not used by any application code path.
export const __testing = { policyFingerprint, excludeUnappliedGitOps }
