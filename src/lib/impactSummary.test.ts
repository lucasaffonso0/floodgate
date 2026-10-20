import { describe, it, expect } from 'vitest'
import { summarizeImpact, impactMessage, type TrafficImpact } from './impactSummary'
import type { CiliumFlowSummary, Draft, NetworkPolicyInfo } from '@/types'

const flow = (o: Partial<CiliumFlowSummary>): CiliumFlowSummary => ({
  id: Math.random().toString(36), src_workload: 'router', src_namespace: 'netbird',
  dst_workload: 'defectdojo-django', dst_namespace: 'defectdojo', dst_port: 8080, protocol: 'TCP',
  verdict: 'FORWARDED', flow_count: 1, has_policy: false,
  first_seen: '2026-10-19T10:00:00Z', last_seen: '2026-10-20T10:00:00Z', ...o,
})
const policy = (o: Partial<NetworkPolicyInfo>): NetworkPolicyInfo => ({
  name: 'p', namespace: 'ns', src_workload: '', src_namespace: '', dst_service: '', dst_port: 0, dst_ports: [],
  policy_type: 'allow', managed: true, policy_types: [], pod_selector: {}, ingress_count: 0, egress_count: 0, ...o,
})
const isolate = (ns: string): Draft => ({
  id: 'x', kind: 'isolate', isolate_namespace: ns, isolate_direction: 'both', isolate_allow_intra: true, isolate_allow_internet: true,
  src_workload: '', src_namespace: '', dst_service: '', dst_namespace: '', dst_ports: [], policy_direction: 'both',
})
const now = new Date('2026-10-20T12:00:00Z')

describe('summarizeImpact', () => {
  it('reports the netbird router losing access when defectdojo is isolated (intra-namespace allowed only)', () => {
    const r = summarizeImpact({
      enabled: true, lastCleared: null, policies: [], drafts: [isolate('defectdojo')],
      flows: [
        flow({}), flow({ dst_port: 8443 }),                                                      // same pair, two ports
        flow({ src_namespace: 'defectdojo', src_workload: 'celery', dst_workload: 'defectdojo-django' }), // intra: still allowed
        flow({ verdict: 'DROPPED', src_workload: 'other' }),                                     // not working today anyway
      ],
    })
    expect(r.breaking_total).toBe(1)
    expect(r.breaking[0]).toMatchObject({ src: 'netbird/router', dst: 'defectdojo/defectdojo-django', ports: [8080, 8443] })
  })

  it('reports nothing when an allow policy already covers that source', () => {
    const allow = policy({ namespace: 'defectdojo', policy_type: 'allow', src_workload: 'router', src_namespace: 'netbird', dst_service: 'defectdojo-django' })
    const r = summarizeImpact({ enabled: true, lastCleared: null, policies: [allow], drafts: [isolate('defectdojo')], flows: [flow({})] })
    expect(r.breaking_total).toBe(0)
  })

  it('a removed allow is reported as breaking the traffic it let through', () => {
    const restrict = policy({ name: 'deny', namespace: 'defectdojo', policy_type: 'restrict-ingress', dst_service: '' })
    const allow = policy({ name: 'allow-router', namespace: 'defectdojo', policy_type: 'allow', src_workload: 'router', src_namespace: 'netbird', dst_service: 'defectdojo-django' })
    const remove: Draft = { id: 'r', kind: 'remove', remove_namespace: 'defectdojo', remove_policy_names: ['allow-router'], src_workload: '', src_namespace: '', dst_service: '', dst_namespace: '', dst_ports: [], policy_direction: 'both' }
    const r = summarizeImpact({ enabled: true, lastCleared: null, policies: [restrict, allow], drafts: [remove], flows: [flow({})] })
    expect(r.breaking_total).toBe(1)
  })
})

describe('impactMessage', () => {
  const base: TrafficImpact = { enabled: true, flows_total: 10, observed_since: '2026-10-10T00:00:00Z', last_cleared: null, breaking_total: 0, breaking: [] }

  it('asks nothing when there is enough history and nothing breaks', () => {
    expect(impactMessage('isolar "x"', base, now)).toBeNull()
  })

  it('lists what would break and how much history it is based on', () => {
    const msg = impactMessage('isolar "defectdojo"', { ...base, breaking_total: 1, breaking: [{ src: 'netbird/router', dst: 'defectdojo/defectdojo-django', ports: [8080], last_seen: '' }] }, now)!
    expect(msg).toContain('Isolar "defectdojo" vai bloquear 1 conexão(ões)')
    expect(msg).toContain('netbird/router → defectdojo/defectdojo-django :8080')
    expect(msg).toContain('Baseado em 10 dia(s)')
    expect(msg).toContain('Aplicar mesmo assim?')
  })

  it('warns when the history is too short to be sure, naming the last clear', () => {
    const msg = impactMessage('isolar "x"', { ...base, observed_since: '2026-10-20T10:00:00Z', last_cleared: '2026-10-20 09:59:00' }, now)!
    expect(msg).toContain('só há 2 hora(s) de tráfego capturado')
    expect(msg).toContain('a Descoberta foi limpa em')
  })

  it('says when Descoberta is off, or the check failed', () => {
    expect(impactMessage('isolar "x"', { ...base, enabled: false }, now)).toContain('A Descoberta está desligada')
    expect(impactMessage('isolar "x"', null, now)).toContain('Não foi possível verificar')
  })

  it('keeps the question the action already asked', () => {
    const msg = impactMessage('remover "p"', base, now, 'Remover esta NetworkPolicy?')!
    expect(msg.startsWith('Remover esta NetworkPolicy?')).toBe(true)
    expect(msg).toContain('Continuar?')
  })
})
