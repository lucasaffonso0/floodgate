import type { NetworkPolicyInfo, ServiceInfo } from '@/types'

// What the Policies tab flags as OBSOLETA (and its bulk "remove obsolete"
// deletes): a managed policy whose source or destination no longer exists.
//
// - The DESTINATION of a policy is a Service (target-service): it's
//   checked against Services, as before.
// - The SOURCE is a workload, and a client needs no Service of its own
//   (netbird's router, a CronJob, a worker): it counts as existing when
//   there's a Service OR a workload by that name. Checking it against
//   Services only flagged policies whose source pods were up and running.
// - workloads === null means the workload list isn't known (not loaded
//   yet, or the request failed): a source without a Service is then given
//   the benefit of the doubt instead of flagged, since the flag feeds a
//   bulk delete.
// - dst_service 'internet' is a sentinel, never obsolete.
//
// Returns a checker bound to one snapshot of Services/workloads, so the
// lookups are built once for a whole list.
export function createOrphanCheck(services: ServiceInfo[], workloads: Set<string> | null): (p: NetworkPolicyInfo) => boolean {
  const serviceKeys = new Set(services.map(s => `${s.namespace}/${s.name}`))
  const serviceNames = new Set(services.map(s => s.name))
  const sourceExists = (ns: string, name: string) =>
    serviceKeys.has(`${ns}/${name}`) || workloads === null || workloads.has(`${ns}/${name}`)

  return p => {
    if (p.policy_type === 'external' || p.policy_type === 'allow-intranamespace') return false
    if (p.policy_type === 'allow') {
      const srcOk = !p.src_workload || sourceExists(p.src_namespace, p.src_workload)
      const dstOk = !p.dst_service || serviceKeys.has(`${p.namespace}/${p.dst_service}`)
      return !srcOk || !dstOk
    }
    if (p.policy_type === 'allow-egress') {
      // The policy lives in the source namespace; the destination Service's
      // namespace isn't recorded, so it's matched by name anywhere.
      const srcOk = !p.src_workload || sourceExists(p.namespace, p.src_workload)
      const dstOk = !p.dst_service || p.dst_service === 'internet' || serviceNames.has(p.dst_service)
      return !srcOk || !dstOk
    }
    // restrict-ingress, restrict-egress, allow-namespace: dst_service lives in p.namespace
    return !!p.dst_service && !serviceKeys.has(`${p.namespace}/${p.dst_service}`)
  }
}
