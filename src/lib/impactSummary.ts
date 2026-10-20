import { simulateImpact } from './simulate'
import type { CiliumFlowSummary, Draft, NetworkPolicyInfo } from '@/types'

export interface ImpactConnection {
  src: string        // "namespace/workload"
  dst: string        // "namespace/workload", or "internet" for external destinations
  ports: number[]
  last_seen: string
}

export interface TrafficImpact {
  // Descoberta (Hubble) is on. Off: there's no traffic to judge against.
  enabled: boolean
  // How much traffic the answer is based on.
  flows_total: number
  observed_since: string | null   // oldest first_seen still stored
  last_cleared: string | null     // last "Limpar" (audit log), if any
  // Connections that work today and would be blocked by the change, one
  // per source/destination (ports merged), most recently seen first.
  breaking_total: number
  breaking: ImpactConnection[]
}

const MAX_LISTED = 30

// Pure core of computeTrafficImpact (trafficImpact.ts), kept free of DB and
// cluster access so it can be unit-tested.
export function summarizeImpact(input: {
  enabled: boolean
  flows: CiliumFlowSummary[]
  policies: NetworkPolicyInfo[]
  drafts: Draft[]
  lastCleared: string | null
}): TrafficImpact {
  const { breaking } = simulateImpact(input.flows, input.policies, input.drafts)
  const byPair = new Map<string, ImpactConnection>()
  // Only traffic that actually goes through today counts as "would break":
  // a flow Hubble already reports DROPPED isn't working now.
  for (const f of breaking) {
    if (f.verdict !== 'FORWARDED') continue
    const src = `${f.src_namespace}/${f.src_workload}`
    const dst = f.dst_namespace === 'internet' ? 'internet' : `${f.dst_namespace}/${f.dst_workload}`
    const key = `${src}→${dst}`
    const entry = byPair.get(key)
    if (!entry) { byPair.set(key, { src, dst, ports: [f.dst_port], last_seen: f.last_seen }); continue }
    if (!entry.ports.includes(f.dst_port)) entry.ports.push(f.dst_port)
    if (f.last_seen > entry.last_seen) entry.last_seen = f.last_seen
  }
  const all = [...byPair.values()]
    .map(c => ({ ...c, ports: c.ports.sort((a, b) => a - b) }))
    .sort((a, b) => (a.last_seen < b.last_seen ? 1 : a.last_seen > b.last_seen ? -1 : 0))
  let observedSince: string | null = null
  for (const f of input.flows) if (observedSince === null || f.first_seen < observedSince) observedSince = f.first_seen
  return {
    enabled: input.enabled,
    flows_total: input.flows.length,
    observed_since: observedSince,
    last_cleared: input.lastCleared,
    breaking_total: all.length,
    breaking: all.slice(0, MAX_LISTED),
  }
}

// How much observed history counts as "enough" to say "nothing would break"
// without a caveat.
export const MIN_OBSERVED_HOURS = 24

// The confirmation text shown before applying, or null when there's nothing
// worth asking about (enough history, nothing blocked) and no base question.
// `base` is the question the action already asked (e.g. "Remover esta
// NetworkPolicy?"): it's kept, with the impact appended.
export function impactMessage(action: string, impact: TrafficImpact | null, now: Date, base?: string): string | null {
  const parts: string[] = []
  if (base) parts.push(base)

  if (impact === null) {
    parts.push(`Não foi possível verificar se ${action} bloqueia algum tráfego.`)
  } else if (!impact.enabled) {
    parts.push(`A Descoberta está desligada: não há tráfego observado para verificar se ${action} bloqueia algo.`)
  } else if (impact.breaking_total > 0) {
    const lines = impact.breaking.map(c => `• ${c.src} → ${c.dst} :${c.ports.join(',')}`)
    const more = impact.breaking_total - impact.breaking.length
    parts.push(
      `⚠ ${capitalize(action)} vai bloquear ${impact.breaking_total} conexão(ões) que hoje funcionam:\n\n${lines.join('\n')}${more > 0 ? `\n… e mais ${more}` : ''}`,
      coverageNote(impact, now),
    )
  } else {
    const hours = observedHours(impact, now)
    if (hours === null) {
      parts.push(`A Descoberta ainda não capturou nenhum tráfego: não há como verificar se ${action} bloqueia algo.`)
    } else if (hours < MIN_OBSERVED_HOURS) {
      parts.push(`Nenhuma conexão observada seria bloqueada, mas só há ${coverage(impact, now)} de tráfego capturado${clearedNote(impact)}. Conexões que não aconteceram nesse período não foram verificadas.`)
    } else if (!base) {
      return null
    }
  }
  parts.push(base ? 'Continuar?' : 'Aplicar mesmo assim?')
  return parts.join('\n\n')
}

function observedHours(impact: TrafficImpact, now: Date): number | null {
  if (!impact.observed_since) return null
  return (now.getTime() - new Date(impact.observed_since).getTime()) / 3_600_000
}

function coverage(impact: TrafficImpact, now: Date): string {
  const hours = observedHours(impact, now) ?? 0
  // Rounded down: "at least this much" history, never more than there is.
  return hours < 1 ? `${Math.max(1, Math.floor(hours * 60))} minuto(s)` : hours < 48 ? `${Math.floor(hours)} hora(s)` : `${Math.floor(hours / 24)} dia(s)`
}

function clearedNote(impact: TrafficImpact): string {
  return impact.last_cleared ? ` (a Descoberta foi limpa em ${formatDate(impact.last_cleared)})` : ''
}

function coverageNote(impact: TrafficImpact, now: Date): string {
  if (observedHours(impact, now) === null) return 'Não há tráfego capturado.'
  return `Baseado em ${coverage(impact, now)} de tráfego capturado${clearedNote(impact)}.`
}

function formatDate(sqliteUtc: string): string {
  // audit_logs.created_at is SQLite's datetime('now'): UTC without a zone.
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(sqliteUtc) ? sqliteUtc : `${sqliteUtc.replace(' ', 'T')}Z`)
  return Number.isNaN(d.getTime()) ? sqliteUtc : d.toLocaleString('pt-BR')
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
