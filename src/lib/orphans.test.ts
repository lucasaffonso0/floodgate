import { describe, it, expect } from 'vitest'
import { createOrphanCheck } from './orphans'
import type { NetworkPolicyInfo, ServiceInfo } from '@/types'

const svc = (namespace: string, name: string): ServiceInfo => ({ namespace, name, selector: { app: name }, ports: [] })
const policy = (o: Partial<NetworkPolicyInfo>): NetworkPolicyInfo => ({
  name: 'p', namespace: 'ns', src_workload: '', src_namespace: '', dst_service: '', dst_port: 0, dst_ports: [],
  policy_type: 'allow', managed: true, policy_types: [], pod_selector: {}, ingress_count: 0, egress_count: 0, ...o,
})

const services = [svc('defectdojo', 'defectdojo-django'), svc('shop', 'api')]
// The real case: netbird's router is a Deployment with running pods but no Service.
const routerToDjango = policy({
  name: 'floodgate-allow-router-netbird-to-defectdojo-django', namespace: 'defectdojo',
  src_workload: 'router', src_namespace: 'netbird', dst_service: 'defectdojo-django', policy_type: 'allow',
})

describe('createOrphanCheck', () => {
  it('does not flag a policy whose source is a workload without a Service', () => {
    const isOrphaned = createOrphanCheck(services, new Set(['netbird/router']))
    expect(isOrphaned(routerToDjango)).toBe(false)
  })

  it('flags it once the source workload is gone too', () => {
    const isOrphaned = createOrphanCheck(services, new Set())
    expect(isOrphaned(routerToDjango)).toBe(true)
  })

  it('still flags a missing destination Service, even with the source alive', () => {
    const isOrphaned = createOrphanCheck(services, new Set(['netbird/router']))
    expect(isOrphaned({ ...routerToDjango, dst_service: 'gone' })).toBe(true)
  })

  it('gives a source without a Service the benefit of the doubt while workloads are unknown', () => {
    expect(createOrphanCheck(services, null)(routerToDjango)).toBe(false)
  })

  it('allow-egress: source checked in the policy namespace, destination by Service name anywhere, internet never obsolete', () => {
    const isOrphaned = createOrphanCheck(services, new Set(['shop/worker']))
    const egress = policy({ namespace: 'shop', src_workload: 'worker', src_namespace: 'shop', dst_service: 'defectdojo-django', policy_type: 'allow-egress' })
    expect(isOrphaned(egress)).toBe(false)
    expect(isOrphaned({ ...egress, dst_service: 'internet' })).toBe(false)
    expect(isOrphaned({ ...egress, src_workload: 'gone' })).toBe(true)
  })

  it('restrict and allow-namespace: only the destination Service matters', () => {
    const isOrphaned = createOrphanCheck(services, new Set())
    expect(isOrphaned(policy({ namespace: 'shop', dst_service: 'api', policy_type: 'restrict-ingress' }))).toBe(false)
    expect(isOrphaned(policy({ namespace: 'shop', dst_service: 'gone', policy_type: 'allow-namespace' }))).toBe(true)
    expect(isOrphaned(policy({ namespace: 'shop', dst_service: '', policy_type: 'restrict-egress' }))).toBe(false)
  })

  it('never flags external or intra-namespace policies', () => {
    const isOrphaned = createOrphanCheck([], new Set())
    expect(isOrphaned(policy({ policy_type: 'external', dst_service: 'x' }))).toBe(false)
    expect(isOrphaned(policy({ policy_type: 'allow-intranamespace' }))).toBe(false)
  })
})
