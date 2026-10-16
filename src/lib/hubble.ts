import 'server-only'
import path from 'path'
import * as grpc from '@grpc/grpc-js'
import * as protoLoader from '@grpc/proto-loader'
import { createHash } from 'crypto'
import { getDb } from './db'
import { listNetworkPolicies, checkHubbleRelayReady, listServices, listPodOwners } from './k8s'
import { getConfig } from './config'
import { emit } from './sse'
import { perfCount } from './perfMetrics'
import { normalizeWorkload, flowHasPolicy, isWorldEndpoint } from './flowMatch'
import type { CiliumFlowSummary, NetworkPolicyInfo } from '@/types'

const PROTO_ROOT = path.join(process.cwd(), 'proto')
const HUBBLE_ADDR = process.env.HUBBLE_RELAY_ADDR ?? 'hubble-relay.kube-system.svc.cluster.local:80'

// Safety net regardless of retention settings: getDiscoveredFlows()/
// getDraftModeFlows() have no other bound, and internet-bound traffic (one
// permanent row per distinct external IP) can outgrow retention faster
// than the hourly cleanup runs. Selected by last_seen (see the ORDER BY
// comment below), so this only ever drops rows that haven't been seen in
// the longest time, never a connection that's still actively happening.
// This must stay well above real steady-state volume: a real environment
// was observed sitting at 10,429 accumulated rows (all internet-bound)
// under the old uniform 7-day retention, before internet traffic got its
// own much shorter window. The point of this constant is to catch
// pathological growth (e.g. retention cleanup itself failing), not to
// trim normal days; if it starts binding under everyday load, it's set
// too low, not doing its job.
const MAX_FLOW_ROWS = 50_000

// ─── Revisões (o que mudou desde a cópia do cliente) ──────────────────────
// Every write to a discovered_flows row stamps it with a rev higher than any
// before it, so "rows with rev > N" is exactly what changed since a client
// saw rev N. Rows removed by retention or the row cap leave a tombstone
// (discovered_flows_deleted) with its own rev, so a delta also lists what
// to drop. Tombstones are pruned after an hour; a client older than that,
// and any delete without tombstones (clearing everything, the one-time
// normalization) start a new generation instead, and a client holding an
// older generation gets the full list again. The generation is random per
// process (on global: shared by every route bundle), so a restart also
// forces a full reload instead of trusting a counter from before it.
const _flowGen = global as typeof global & { _hubbleFlowGeneration?: string; _hubbleTombstoneFloor?: number }
function flowGeneration(): string {
  return (_flowGen._hubbleFlowGeneration ??= Math.random().toString(36).slice(2, 10))
}
function bumpFlowGeneration(): void {
  _flowGen._hubbleFlowGeneration = Math.random().toString(36).slice(2, 10)
}
// Highest rev ever handed out, live rows and tombstones alike: taking it
// from live rows alone would reuse a rev after its row got deleted.
function maxFlowRev(): number {
  const r = getDb().prepare('SELECT MAX(m) AS m FROM (SELECT MAX(rev) AS m FROM discovered_flows UNION ALL SELECT MAX(rev) FROM discovered_flows_deleted)').get() as { m: number | null }
  return r.m ?? 0
}
function nextFlowRev(): number {
  return maxFlowRev() + 1
}
// Tombstones are kept for an hour, and at most MAX_TOMBSTONES of them (heavy
// churn past the row cap can delete tens of thousands of rows a minute).
// Whatever gets pruned raises the floor: a client whose version is older
// than the floor can no longer get a correct delta and gets the full list.
const TOMBSTONE_TTL_MS = 3_600_000
const MAX_TOMBSTONES = 100_000
export function pruneTombstones(): void {
  const db = getDb()
  const cutoff = new Date(Date.now() - TOMBSTONE_TTL_MS).toISOString()
  const byAge = (db.prepare('SELECT MAX(rev) AS m FROM discovered_flows_deleted WHERE deleted_at < ?').get(cutoff) as { m: number | null }).m
  const byCount = (db.prepare('SELECT rev AS m FROM discovered_flows_deleted ORDER BY rev DESC LIMIT 1 OFFSET ?').get(MAX_TOMBSTONES) as { m: number } | undefined)?.m ?? null
  const upTo = Math.max(byAge ?? -1, byCount ?? -1)
  if (upTo < 0) return
  // Keep the newest tombstone even if pruned by age: it may hold the
  // highest rev handed out (see maxFlowRev).
  db.prepare('DELETE FROM discovered_flows_deleted WHERE rev <= ? AND rev < (SELECT MAX(rev) FROM discovered_flows_deleted)').run(upTo)
  _flowGen._hubbleTombstoneFloor = Math.max(_flowGen._hubbleTombstoneFloor ?? 0, upTo)
}

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
  // starts, or for owners it doesn't know, like Strimzi's StrimziPodSet) and
  // falls back to the raw pod name. That name is looked up in the pod owner
  // map first (real owner references, so a StatefulSet's "kafka-0" becomes
  // "kafka"), then normalized either way so the same logical service always
  // gets the same identity across flow records (this also fixes duplicate
  // rows for what's really one src→dst pair).
  const podName: string | undefined = ep?.pod_name || undefined
  let workload = workloads[0]?.name
    ?? (podName ? _podOwners.get(`${namespace}/${podName}`) ?? podName : '')
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
// namespace → (serviceName → Set de target_ports declarados no Service).
// Indexado por namespace pra que o prefix match abaixo só percorra os
// Services da namespace do destino, não os do cluster inteiro.
let _svcPortCache = new Map<string, Map<string, Set<number>>>()
let _svcPortCacheAt = 0
let _svcPortCacheRefreshing = false

async function refreshSvcPortCache(): Promise<void> {
  if (_svcPortCacheRefreshing) return
  _svcPortCacheRefreshing = true
  try {
    const services = await listServices()
    const cache = new Map<string, Map<string, Set<number>>>()
    for (const svc of services) {
      let byName = cache.get(svc.namespace)
      if (!byName) { byName = new Map(); cache.set(svc.namespace, byName) }
      let ports = byName.get(svc.name)
      if (!ports) { ports = new Set(); byName.set(svc.name, ports) }
      for (const p of svc.ports) {
        ports.add(p.port)
        if (p.target_port) ports.add(p.target_port)
      }
    }
    _svcPortCache = cache
    _svcPortCacheAt = Date.now()
  } catch { /* non-critical: mantém cache antigo */ }
  finally { _svcPortCacheRefreshing = false }
}

function isKnownServicePort(namespace: string, workload: string, port: number): boolean {
  const byName = _svcPortCache.get(namespace)
  if (!byName) return false
  if (byName.get(workload)?.has(port)) return true
  // Prefix match: workload pode ser nome de pod como "haproxy-abc12-xyz99", service é "haproxy"
  for (const [svcName, ports] of byName) {
    if (workload.startsWith(svcName + '-') || workload.startsWith(svcName + '_')) {
      if (ports.has(port)) return true
    }
  }
  return false
}

// ─── Dono de cada pod (namespace/pod → workload), para quando o Cilium só
// manda o nome do pod. Atualizado em background, mesmo padrão do cache de
// ports acima; vem do watch de pods, então refrescar é barato. ──────────────
let _podOwners = new Map<string, string>()
let _podOwnersAt = 0
let _podOwnersRefreshing = false

async function refreshPodOwners(): Promise<void> {
  if (_podOwnersRefreshing) return
  _podOwnersRefreshing = true
  try {
    _podOwners = await listPodOwners()
    _podOwnersAt = Date.now()
  } catch { /* non-critical: mantém o mapa antigo */ }
  finally { _podOwnersRefreshing = false }
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
// No global, como o buffer de escrita: clearDiscoveredFlows() roda no bundle
// da rota e precisa esvaziar o mesmo mapa que o stream (bundle do scheduler)
// consulta.
const _dedupHolder = global as typeof global & { _hubbleConnDedup?: Map<string, number> }
const _connDedup = (_dedupHolder._hubbleConnDedup ??= new Map<string, number>())
const CONN_TTL_MS = 120_000  // remove entradas após 2 min (porta efêmera não será reutilizada tão cedo)

function isNewConnection(id: string, srcPort: number): boolean {
  if (srcPort === 0) return true  // campo não preenchido → não deduplica
  const key = `${id}:${srcPort}`
  if (_connDedup.has(key)) return false
  _connDedup.set(key, Date.now())
  return true
}

// Varrido por timer (ver startFlowWriter), não a cada conexão nova: com o
// mapa acima do limite, a varredura antiga rodava inteira em cada flow novo.
function sweepConnDedup(): void {
  const cutoff = Date.now() - CONN_TTL_MS
  for (const [k, ts] of _connDedup) { if (ts < cutoff) _connDedup.delete(k) }
}

// ─── Escrita em lote ──────────────────────────────────────────────────────
// Cada evento do Hubble era um INSERT/UPDATE próprio (com fsync no commit).
// Agora os eventos se acumulam em memória, um item por linha (tabela + id),
// e vão pro banco numa única transação a cada FLUSH_INTERVAL_MS. A semântica
// por linha é a mesma de antes: flow_count soma só conexões novas, o
// veredito e o last_seen são os do último evento, has_policy é o calculado
// na primeira conexão nova, e uma linha que só recebeu repetições é apenas
// atualizada (nunca criada).
type FlowTable = 'discovered_flows' | 'ignored_flows'
type PendingFlow = {
  table: FlowTable
  id: string
  src_workload: string; src_namespace: string; dst_workload: string; dst_namespace: string
  dst_port: number; protocol: string
  verdict: string
  first_seen: string
  last_seen: string
  new_conns: number
  has_policy: number
}

const FLUSH_INTERVAL_MS = 1_000
const MAX_PENDING_FLOWS = 5_000      // flush antecipado se um pico encher o buffer
const DEDUP_SWEEP_INTERVAL_MS = 30_000

// No global, não no módulo: o Next empacota cada rota separado, e
// clearDiscoveredFlows()/snapshotFlowsForDraftMode() chamados de uma rota
// precisam ver o mesmo buffer que o stream (iniciado pelo scheduler) enche.
const _flowBuffer = global as typeof global & { _hubblePendingFlows?: Map<string, PendingFlow> }
const _pendingFlows = (_flowBuffer._hubblePendingFlows ??= new Map<string, PendingFlow>())

type FlowStatements = { upsert: Record<FlowTable, ReturnType<ReturnType<typeof getDb>['prepare']>>; update: Record<FlowTable, ReturnType<ReturnType<typeof getDb>['prepare']>> }
let _flowStatements: { db: ReturnType<typeof getDb>; stmts: FlowStatements } | null = null

function flowStatements(): FlowStatements {
  const db = getDb()
  if (_flowStatements?.db === db) return _flowStatements.stmts
  const upsert = (table: FlowTable) => db.prepare(`
    INSERT INTO ${table} (id, src_workload, src_namespace, dst_workload, dst_namespace, dst_port, protocol, verdict, flow_count, has_policy, first_seen, last_seen, rev)
    VALUES (@id, @src_workload, @src_namespace, @dst_workload, @dst_namespace, @dst_port, @protocol, @verdict, @new_conns, @has_policy, @first_seen, @last_seen, @rev)
    ON CONFLICT(id) DO UPDATE SET
      flow_count = ${table}.flow_count + excluded.flow_count,
      verdict = excluded.verdict,
      last_seen = excluded.last_seen,
      rev = excluded.rev
  `)
  const update = (table: FlowTable) => db.prepare(`UPDATE ${table} SET verdict = @verdict, last_seen = @last_seen, rev = @rev WHERE id = @id`)
  const stmts = {
    upsert: { discovered_flows: upsert('discovered_flows'), ignored_flows: upsert('ignored_flows') },
    update: { discovered_flows: update('discovered_flows'), ignored_flows: update('ignored_flows') },
  }
  _flowStatements = { db, stmts }
  return stmts
}

function queueFlowWrite(row: Omit<PendingFlow, 'first_seen' | 'new_conns' | 'has_policy'>, isNew: boolean, hasPolicy: () => boolean): void {
  const key = `${row.table}:${row.id}`
  const pending = _pendingFlows.get(key)
  if (pending) {
    pending.verdict = row.verdict
    pending.last_seen = row.last_seen
    if (isNew) {
      if (pending.new_conns === 0) pending.has_policy = hasPolicy() ? 1 : 0
      pending.new_conns++
    }
  } else {
    _pendingFlows.set(key, { ...row, first_seen: row.last_seen, new_conns: isNew ? 1 : 0, has_policy: isNew && hasPolicy() ? 1 : 0 })
  }
  if (_pendingFlows.size >= MAX_PENDING_FLOWS) flushFlowWrites()
}

// Grava tudo o que está pendente numa transação. Chamado pelo timer, antes
// de qualquer leitura/escrita que precise do estado completo (snapshot do
// Modo Rascunho, migração de ignorados) e ao parar o stream/processo.
export function flushFlowWrites(): void {
  if (_pendingFlows.size === 0) return
  const batch = [..._pendingFlows.values()]
  _pendingFlows.clear()
  let touchedDiscovered = false
  try {
    const { upsert, update } = flowStatements()
    getDb().transaction(() => {
      const rev = nextFlowRev()
      for (const f of batch) {
        if (f.new_conns > 0) {
          perfCount('hubble.db_upsert')
          upsert[f.table].run({ ...f, rev })
        } else {
          perfCount('hubble.db_update')
          update[f.table].run({ id: f.id, verdict: f.verdict, last_seen: f.last_seen, rev })
        }
        if (f.table === 'discovered_flows') touchedDiscovered = true
      }
    })()
    perfCount('hubble.flush_batches')
  } catch (e) {
    console.error('[hubble] DB write error:', e)
    return
  }

  // Emit SSE no máximo a cada 3s para não sobrecarregar o frontend, só
  // pros visíveis (discovered_flows); flows de namespace ignorada não têm
  // nada pra atualizar na tela agora mesmo.
  if (touchedDiscovered) {
    const lastEmit = g._hubbleLastSseEmit ?? 0
    if (Date.now() - lastEmit > 3000) {
      g._hubbleLastSseEmit = Date.now()
      emit({ type: 'hubble_flow_new', version: getDiscoveredFlowsSummary().version })
    }
  }
}

function startFlowWriter(): void {
  if (g._hubbleFlushTimer) return
  let lastSweep = Date.now()
  g._hubbleFlushTimer = setInterval(() => {
    flushFlowWrites()
    if (Date.now() - lastSweep >= DEDUP_SWEEP_INTERVAL_MS) {
      lastSweep = Date.now()
      sweepConnDedup()
    }
  }, FLUSH_INTERVAL_MS)
  g._hubbleFlushTimer.unref?.()
  if (!g._hubbleExitHooked) {
    g._hubbleExitHooked = true
    // Grava o último segundo pendente quando o pod recebe SIGTERM. Se não
    // houver outro handler pro sinal (o Next registra o dele), re-emite
    // pra manter o comportamento padrão de encerrar o processo.
    for (const sig of ['SIGTERM', 'SIGINT'] as const) {
      process.once(sig, () => {
        flushFlowWrites()
        if (process.listenerCount(sig) === 0) process.kill(process.pid, sig)
      })
    }
  }
}

function stopFlowWriter(): void {
  if (g._hubbleFlushTimer) { clearInterval(g._hubbleFlushTimer); g._hubbleFlushTimer = undefined }
  flushFlowWrites()
}

// ─── Global streaming state ────────────────────────────────────────────────
const g = global as typeof global & {
  _hubbleClient?: ObserverClient
  _hubbleStream?: grpc.ClientReadableStream<unknown>
  _hubbleStreaming?: boolean
  _hubbleRetryTimer?: ReturnType<typeof setTimeout>
  _hubbleLastSseEmit?: number
  _hubbleFlushTimer?: ReturnType<typeof setInterval>
  _hubbleExitHooked?: boolean
}

export function isHubbleStreaming(): boolean {
  return g._hubbleStreaming === true
}

// ─── Process individual flow from stream ──────────────────────────────────
function processFlow(msg: unknown): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const flow = (msg as any)?.flow
  if (!flow) return
  perfCount('hubble.received')
  // is_reply: true = the server-to-client half of a connection (the relay
  // already filters these out, see startHubbleStream; skipped here too in
  // case a relay ignores the filter). false = the request direction, so
  // the destination port is the real service port. null = Hubble doesn't
  // know (policy-verdict events, many drops): falls back to the port
  // heuristic below.
  const isReply: boolean | null = flow.is_reply == null ? null : !!flow.is_reply.value
  if (isReply === true) return

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
  if (portInfo.port >= 32768 && !dstIsWorld && isReply === null) {
    // Porta alta sem saber o sentido: só aceita se for port declarado em algum
    // K8s Service real do destino. Caso contrário, é provavelmente porta efêmera
    // de resposta TCP (Hubble captura os dois sentidos). Com is_reply=false o
    // sentido é conhecido e a porta é real (ex: WireGuard 51820/UDP, que nenhum
    // Service declara), então não passa por aqui.
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
  if (Date.now() - _podOwnersAt > 30_000) refreshPodOwners()       // refresh async em background

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

  queueFlowWrite(
    { table, id, src_workload: src.workload, src_namespace: src.namespace, dst_workload: dstWorkload, dst_namespace: dst.namespace, dst_port: portInfo.port, protocol: portInfo.protocol, verdict, last_seen: now },
    isNew,
    () => flowHasPolicy(
      { src_workload: src.workload, src_namespace: src.namespace, dst_workload: dstWorkload, dst_namespace: dst.namespace, dst_port: portInfo.port },
      _policyCache,
    ),
  )
}

// ─── Start / stop stream ───────────────────────────────────────────────────
export function startHubbleStream(): void {
  if (g._hubbleStreaming) return
  if (g._hubbleRetryTimer) { clearTimeout(g._hubbleRetryTimer); g._hubbleRetryTimer = undefined }

  console.log('[hubble] starting real-time stream')
  g._hubbleStreaming = true
  refreshSvcPortCache()  // popula cache de ports antes dos primeiros flows
  refreshPolicyCache()   // popula cache de policies antes dos primeiros flows
  refreshPodOwners()     // popula o dono dos pods antes dos primeiros flows
  startFlowWriter()

  try {
    const client = loadClient()
    g._hubbleClient = client
    // Filtered at the relay: only the verdicts processFlow() keeps, and no
    // reply packets (the server-to-client half of every connection, which
    // processFlow() never wanted either). Roughly halves what the relay
    // sends and this process decodes. Replies are EXCLUDED via the
    // blacklist, not "reply: false" in the whitelist: that one also drops
    // every flow whose is_reply is unknown, which includes policy-verdict
    // events and many DROPPED flows.
    const stream = client.GetFlows({
      number: '0', follow: true,
      whitelist: [{ verdict: ['FORWARDED', 'DROPPED', 'AUDIT'] }],
      blacklist: [{ reply: [true] }],
    }, new grpc.Metadata())
    g._hubbleStream = stream

    stream.on('data', processFlow)

    stream.on('error', (err: Error) => {
      console.error('[hubble] stream error:', err.message)
      stopFlowWriter()
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
      stopFlowWriter()
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
  stopFlowWriter()
  g._hubbleClient?.close()
  g._hubbleStream = undefined
  g._hubbleClient = undefined
  g._hubbleStreaming = false
  console.log('[hubble] stream stopped')
}

// flowHasPolicy() only depends on these fields, and for an internet-bound
// flow only on its source (the external IP and port never matter there:
// coverage is the source's internet-egress posture). Rows sharing a key
// share the answer, so a table of tens of thousands of internet rows needs
// a few hundred evaluations instead of one per row.
function classificationKey(f: { src_workload: string; src_namespace: string; dst_workload: string; dst_namespace: string; dst_port: number }): string {
  return f.dst_namespace === 'internet'
    ? `${f.src_namespace}|${f.src_workload}|internet`
    : `${f.src_namespace}|${f.src_workload}|${f.dst_namespace}|${f.dst_workload}|${f.dst_port}`
}

const RECLASSIFY_WRITE_CHUNK = 2_000

// Memoized per classificationKey, writes only rows whose value actually
// changed, and in chunks that yield to the event loop between them, so a
// policy change over a large table never stalls the server in one block.
async function reclassifyFlowPolicies(table: 'discovered_flows' | 'ignored_flows', allPolicies: NetworkPolicyInfo[]): Promise<void> {
  const db = getDb()
  const flows = db.prepare(`SELECT id, src_workload, src_namespace, dst_workload, dst_namespace, dst_port, has_policy FROM ${table}`).all() as Array<{
    id: string; src_workload: string; src_namespace: string; dst_workload: string; dst_namespace: string; dst_port: number; has_policy: number
  }>
  if (flows.length === 0) return
  const memo = new Map<string, number>()
  const changes: Array<[number, string]> = []
  for (const f of flows) {
    const key = classificationKey(f)
    let value = memo.get(key)
    if (value === undefined) {
      value = flowHasPolicy(f, allPolicies) ? 1 : 0
      memo.set(key, value)
    }
    if (value !== f.has_policy) changes.push([value, f.id])
  }
  perfCount('hubble.reclassify_evaluations', memo.size)
  perfCount('hubble.reclassify_writes', changes.length)
  const updateStmt = db.prepare(`UPDATE ${table} SET has_policy = ?, rev = ? WHERE id = ?`)
  const writeChunk = db.transaction((chunk: Array<[number, string]>) => {
    const rev = nextFlowRev()
    for (const [value, id] of chunk) updateStmt.run(value, rev, id)
  })
  for (let i = 0; i < changes.length; i += RECLASSIFY_WRITE_CHUNK) {
    writeChunk(changes.slice(i, i + RECLASSIFY_WRITE_CHUNK))
    if (i + RECLASSIFY_WRITE_CHUNK < changes.length) await new Promise(res => setImmediate(res))
  }
}

// reclassifyFlowPolicies() is O(flows × policies): checking every flow's
// has_policy against every policy is only ever needed again when the
// policy SET has actually changed since the last tick (policy creation/
// deletion/port-edit are rare admin actions, not something that happens
// every 15s). This fingerprint is a cheap stand-in for "did anything
// relevant change" (only the fields flowHasPolicy()/explainAccess() ever
// look at), so an unrelated field changing (e.g. created_at) never causes
// a false "changed".
// null, not '': an empty policy list fingerprints to '', so starting at ''
// would skip the first reclassification after a restart with no policies.
let _lastPolicyFingerprint: string | null = null
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
    // A failed read is skipped (keep the current classification), but an
    // empty list is a real answer: the last policy was deleted or
    // everything was paused, and flows must stop showing as covered.
    let allPolicies: NetworkPolicyInfo[]
    try {
      allPolicies = await listNetworkPolicies(true)
    } catch {
      return
    }

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

    await reclassifyFlowPolicies('discovered_flows', applied)
    await reclassifyFlowPolicies('ignored_flows', applied)
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
  if (table === 'discovered_flows') bumpFlowGeneration()
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
const RETENTION_DELETE_CHUNK = 5_000

// Deletes in chunks with a yield to the event loop between them: a first
// cleanup over a large backlog (or a retention setting just shortened) used
// to be a single DELETE holding the server for as long as it took.
async function deleteInChunks(table: FlowTable, where: string, ...params: unknown[]): Promise<number> {
  const db = getDb()
  const select = db.prepare(`SELECT rowid AS r, id FROM ${table} WHERE ${where} LIMIT ${RETENTION_DELETE_CHUNK}`)
  const del = db.prepare(`DELETE FROM ${table} WHERE rowid = ?`)
  const tomb = db.prepare('INSERT INTO discovered_flows_deleted (id, rev, deleted_at) VALUES (?, ?, ?)')
  // discovered_flows leaves a tombstone per row, in the same transaction,
  // so clients get the removal as part of their next delta.
  const chunk = db.transaction(() => {
    const rows = select.all(...params) as Array<{ r: number; id: string }>
    if (rows.length === 0) return 0
    const rev = table === 'discovered_flows' ? nextFlowRev() : 0
    const now = new Date().toISOString()
    for (const row of rows) {
      del.run(row.r)
      if (table === 'discovered_flows') tomb.run(row.id, rev, now)
    }
    return rows.length
  })
  let total = 0
  for (;;) {
    const n = chunk() as number
    total += n
    if (n < RETENTION_DELETE_CHUNK) return total
    await new Promise(res => setImmediate(res))
  }
}

// Keeps a flow table at MAX_FLOW_ROWS rows, dropping the ones seen longest
// ago. For discovered_flows this is also what keeps deltas usable: rows
// past the cap would otherwise drop out of the capped list without being
// deleted, which a "changed since" query can't express, so every client
// would be stuck re-downloading the full list. Logged, since hitting it
// means retention alone isn't keeping up.
export async function capFlowTable(table: FlowTable): Promise<void> {
  const count = (getDb().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c
  if (count <= MAX_FLOW_ROWS) return
  const cutoff = getDb().prepare(`SELECT last_seen FROM ${table} ORDER BY last_seen DESC LIMIT 1 OFFSET ?`).get(MAX_FLOW_ROWS) as { last_seen: string } | undefined
  if (!cutoff) return
  const deleted = await deleteInChunks(table, 'last_seen <= ?', cutoff.last_seen)
  console.warn(`[hubble] ${table} passou de ${MAX_FLOW_ROWS} linhas: ${deleted} vistas há mais tempo removidas`)
}

export async function runRetentionCleanup(): Promise<void> {
  try {
    const cfg = getConfig()
    const staleDate = new Date(Date.now() - (cfg.hubble_flow_retention_days ?? 7) * 86400 * 1000).toISOString()
    const staleInternetDate = new Date(Date.now() - (cfg.hubble_internet_flow_retention_days ?? 1) * 86400 * 1000).toISOString()
    for (const table of ['discovered_flows', 'ignored_flows'] as const) {
      const deleted =
        await deleteInChunks(table, "dst_namespace != 'internet' AND last_seen < ?", staleDate) +
        await deleteInChunks(table, "dst_namespace = 'internet' AND last_seen < ?", staleInternetDate)
      void deleted
    }
    pruneTombstones()
    await capFlowTable('ignored_flows')
    await capFlowTable('discovered_flows')
  } catch (e) {
    console.error('[hubble] limpeza de retenção falhou:', e)
  }
}

// ─── Migra de volta pra discovered_flows os flows de uma namespace que
// deixou de ser ignorada (chamado por PUT /api/config quando a lista de
// ignored_namespaces perde alguma entrada) ─────────────────────────────────
export function migrateUnignoredFlows(newIgnoredNamespaces: string[]): void {
  try {
    flushFlowWrites()
    const db = getDb()
    // Só migra quem não tem NENHUM dos dois lados ainda ignorado: um flow
    // entre duas namespaces ignoradas continua escondido até as duas saírem
    // da lista. Feito inteiro em SQL (INSERT ... SELECT), sem carregar a
    // tabela na memória.
    const stillIgnored = JSON.stringify(newIgnoredNamespaces)
    const movable = `src_namespace NOT IN (SELECT value FROM json_each(@ignored)) AND dst_namespace NOT IN (SELECT value FROM json_each(@ignored))`
    db.transaction(() => {
      const rev = nextFlowRev()
      const moved = db.prepare(`
        INSERT INTO discovered_flows (id, src_workload, src_namespace, dst_workload, dst_namespace, dst_port, protocol, verdict, flow_count, has_policy, first_seen, last_seen, rev)
        SELECT id, src_workload, src_namespace, dst_workload, dst_namespace, dst_port, protocol, verdict, flow_count, has_policy, first_seen, last_seen, @rev
        FROM ignored_flows WHERE ${movable}
        ON CONFLICT(id) DO UPDATE SET
          flow_count = discovered_flows.flow_count + excluded.flow_count,
          verdict = excluded.verdict,
          rev = excluded.rev,
          last_seen = CASE WHEN excluded.last_seen > discovered_flows.last_seen THEN excluded.last_seen ELSE discovered_flows.last_seen END,
          first_seen = CASE WHEN excluded.first_seen < discovered_flows.first_seen THEN excluded.first_seen ELSE discovered_flows.first_seen END
      `).run({ ignored: stillIgnored, rev }).changes
      if (moved > 0) db.prepare(`DELETE FROM ignored_flows WHERE ${movable}`).run({ ignored: stillIgnored })
    })()
  } catch (e) {
    console.error('[hubble] migração de flows des-ignorados falhou:', e)
  }
}

// ─── API pública ───────────────────────────────────────────────────────────
export async function checkHubbleAvailable(): Promise<boolean> {
  return checkHubbleRelayReady()
}

// Cheap stand-in for "did the flow list change": one aggregate query instead
// of serializing up to MAX_FLOW_ROWS rows. The version is the generation
// plus the highest rev (see nextFlowRev): every write raises the rev, every
// delete starts a new generation, so it changes exactly when the list does.
// It doubles as the token a client passes back to get only what changed
// (getDiscoveredFlowsSince).
export function getDiscoveredFlowsSummary(): { version: string; total: number; unprotected_dropped: number } {
  const r = getDb().prepare(`
    SELECT COUNT(*) AS c, TOTAL(verdict = 'DROPPED' AND has_policy = 0) AS u
    FROM discovered_flows
  `).get() as { c: number; u: number }
  return { version: `${flowGeneration()}.${maxFlowRev()}`, total: r.c, unprotected_dropped: r.u }
}

function toFlowSummary(r: Record<string, unknown>): CiliumFlowSummary {
  return {
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
  }
}

// Only the rows changed since `since` (a version from the summary or a
// previous call), when that's safe: same generation (nothing deleted since)
// and the table under MAX_FLOW_ROWS (above it, rows can fall out of the
// capped list without being deleted). Otherwise the full list, flagged
// `full` so the client replaces its copy instead of merging into it.
export function getDiscoveredFlowsSince(since: string | null): { version: string; full: boolean; flows: CiliumFlowSummary[]; removed: string[] } {
  const summary = getDiscoveredFlowsSummary()
  const [gen, revStr] = (since ?? '').split('.')
  const sinceRev = Number(revStr)
  const deltaSafe = since && gen === flowGeneration() && Number.isInteger(sinceRev)
    && sinceRev >= (_flowGen._hubbleTombstoneFloor ?? 0) // tombstones it would need are pruned
    && summary.total <= MAX_FLOW_ROWS
  if (deltaSafe) {
    perfCount('flows.read_delta')
    const db = getDb()
    const rows = db.prepare('SELECT * FROM discovered_flows WHERE rev > ? ORDER BY first_seen DESC, id').all(sinceRev) as Array<Record<string, unknown>>
    const live = new Set(rows.map(r => r.id as string))
    // A row deleted and later seen again is live again: not removed.
    const removed = (db.prepare('SELECT DISTINCT id FROM discovered_flows_deleted WHERE rev > ?').all(sinceRev) as Array<{ id: string }>)
      .map(r => r.id).filter(id => !live.has(id))
    return { version: summary.version, full: false, flows: rows.map(toFlowSummary), removed }
  }
  return { version: summary.version, full: true, flows: getDiscoveredFlows(), removed: [] }
}

export function getDiscoveredFlows(): CiliumFlowSummary[] {
  const db = getDb()
  perfCount('flows.read_full')
  // Two different concerns, deliberately kept apart:
  // - WHICH rows survive the MAX_FLOW_ROWS cap: by last_seen, so a flow
  //   still happening right now is never pushed out in favor of one just
  //   discovered a moment ago (first_seen never moves once set, so an
  //   old-but-still-active connection would otherwise look "stale" to this
  //   cap even though it's the opposite).
  // - The ORDER the surviving rows are returned in: by first_seen, stable
  //   across polls (unlike flow_count, which reshuffles as active flows
  //   accumulate hits at different rates) because the graph assigns edge
  //   curvature by array position.
  const rows = db.prepare(`
    SELECT * FROM (
      SELECT * FROM discovered_flows ORDER BY last_seen DESC, id LIMIT ?
    ) ORDER BY first_seen DESC, id
  `).all(MAX_FLOW_ROWS) as Array<Record<string, unknown>>
  return rows.map(toFlowSummary)
}

// Retorna quantas linhas apagou, para a auditoria registrar o tamanho do
// que foi limpo.
export function clearDiscoveredFlows(): { discovered: number; ignored: number } {
  // Descarta o que ainda não foi gravado: senão o próximo flush recriaria
  // as linhas que o usuário acabou de limpar.
  _pendingFlows.clear()
  // E esquece as conexões já vistas: senão uma conexão que continua ativa
  // (mesma porta de origem) seria tratada como repetição, que só atualiza
  // uma linha que acabou de ser apagada, e sumiria da Descoberta até essa
  // memória expirar.
  _connDedup.clear()
  const db = getDb()
  const discovered = db.prepare('DELETE FROM discovered_flows').run().changes
  const ignored = db.prepare('DELETE FROM ignored_flows').run().changes
  db.prepare('DELETE FROM discovered_flows_deleted').run()
  bumpFlowGeneration()
  return { discovered, ignored }
}

// ── Modo Rascunho ────────────────────────────────────────────────────────
// A frozen copy of discovered_flows, taken once when Modo Rascunho turns
// on: the fixed baseline drafts are compared against. Never written back
// into discovered_flows: live Hubble ingestion keeps running untouched.
export function snapshotFlowsForDraftMode(): void {
  flushFlowWrites()
  const db = getDb()
  db.exec('DELETE FROM draft_mode_flows')
  // Same row budget as the live list: only what getDiscoveredFlows() would
  // show is worth comparing drafts against.
  db.prepare('INSERT INTO draft_mode_flows SELECT * FROM discovered_flows ORDER BY last_seen DESC LIMIT ?').run(MAX_FLOW_ROWS)
}

export function getDraftModeFlows(): CiliumFlowSummary[] {
  // Same last_seen-selects/first_seen-displays split as getDiscoveredFlows().
  const rows = getDb().prepare(`
    SELECT * FROM (
      SELECT * FROM draft_mode_flows ORDER BY last_seen DESC, id LIMIT ?
    ) ORDER BY first_seen DESC, id
  `).all(MAX_FLOW_ROWS) as Array<Record<string, unknown>>
  return rows.map(toFlowSummary)
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
export const __testing = { policyFingerprint, excludeUnappliedGitOps, processFlow, refreshPodOwners }
