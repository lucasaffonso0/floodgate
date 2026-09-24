import 'server-only'
import * as k8s from '@kubernetes/client-node'
import yaml from 'js-yaml'
import { createHash } from 'crypto'
import { UserFacingError } from '@/lib/api-helpers'
import { normalizeWorkload } from '@/lib/flowMatch'
import { identityLabels } from '@/lib/podIdentity'
import { getWriteMode } from '@/lib/writeMode'
import {
  createRestrictPolicyViaGit, deleteNetworkPolicyViaGit, createNetworkPolicyViaGit, createEgressNetworkPolicyViaGit,
  createNamespaceIngressPolicyViaGit, createNamespaceRestrictPolicyViaGit, isolateNamespaceViaGit, createCidrPolicyViaGit,
  getPolicyYAMLViaGit, applyPolicyYAMLViaGit, adoptPolicyViaGit, unadoptPolicyViaGit, patchNetworkPolicyPortViaGit,
  mergeGitSyncStatus, deleteNetworkPoliciesBatchViaGit,
} from '@/lib/k8s-gitops'
import type { ServiceInfo, NetworkPolicyInfo, CreatePolicyRequest, PortSpec, RestrictPolicyRequest, IsolateNamespaceRequest, CidrPolicyRequest } from '@/types'

export const MANAGED_BY = 'floodgate'

// DNS-1123 subdomain-safe policy name. No-op for names that are already valid
// and ≤63 chars (keeps existing policy names stable); otherwise cleans invalid
// chars and appends a deterministic hash so two long inputs can't collide by
// truncation (the 409→replace fallback would silently overwrite the first).
export function sanitizeK8sName(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  if (cleaned === raw && raw.length > 0 && raw.length <= 63) return raw
  const hash = createHash('sha1').update(raw).digest('hex').slice(0, 6)
  const base = (cleaned || 'policy').slice(0, 56).replace(/-+$/, '')
  return `${base}-${hash}`
}

// Valid K8s label value: alphanumeric start/end, [-A-Za-z0-9_.] middle, ≤63.
// No-op for valid values (service/namespace names always are).
export function sanitizeLabelValue(raw: string): string {
  return raw
    .replace(/[^A-Za-z0-9\-_.]+/g, '-')
    .slice(0, 63)
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[^A-Za-z0-9]+$/, '')
}

const kc = new k8s.KubeConfig()
kc.loadFromDefault()

const core = kc.makeApiClient(k8s.CoreV1Api)
const networking = kc.makeApiClient(k8s.NetworkingV1Api)
const apps = kc.makeApiClient(k8s.AppsV1Api)

// @kubernetes/client-node models V1NetworkPolicyIngressRule.from as `_from`
// (its JS identifier), since it's serialized back to `from` only through the
// client's own ObjectSerializer: never when we hand the raw object to
// yaml.dump directly. Rename before dumping any spec read from the API.
export function yamlSafeSpec(spec: k8s.V1NetworkPolicySpec | undefined): unknown {
  if (!spec) return spec
  const ingress = spec.ingress?.map(rule => {
    const { _from, ...rest } = rule as typeof rule & { _from?: unknown }
    return _from !== undefined ? { ...rest, from: _from } : rest
  })
  return ingress ? { ...spec, ingress } : spec
}

function getK8sStatus(e: unknown): number | undefined {
  const err = e as { statusCode?: number; body?: unknown; message?: string }
  if (typeof err.statusCode === 'number') return err.statusCode
  try {
    const body = typeof err.body === 'string' ? JSON.parse(err.body) : err.body
    if (typeof (body as { code?: number })?.code === 'number') return (body as { code: number }).code
  } catch {}
  const match = (err.message ?? '').match(/HTTP-Code:\s*(\d+)/)
  if (match) return parseInt(match[1], 10)
  return undefined
}

function parseIntOrString(val: unknown, fallback: number): number {
  if (typeof val === 'number') return val
  if (typeof val === 'string') {
    const n = parseInt(val)
    return isNaN(n) ? fallback : n
  }
  return fallback
}

export async function listServices(): Promise<ServiceInfo[]> {
  const list = await core.listServiceForAllNamespaces()
  const result: ServiceInfo[] = []

  for (const svc of list.items) {
    const selector = svc.spec?.selector
    if (!selector || Object.keys(selector).length === 0) continue

    const ports = (svc.spec?.ports ?? []).map((p: k8s.V1ServicePort) => ({
      port: p.port ?? 80,
      target_port: parseIntOrString(p.targetPort, p.port ?? 80),
      protocol: p.protocol ?? 'TCP',
    }))

    result.push({
      name: svc.metadata!.name!,
      namespace: svc.metadata!.namespace!,
      selector: selector as Record<string, string>,
      ports,
      cluster_ip: svc.spec?.clusterIP,
    })
  }
  return result
}

function selectorOf(svc: k8s.V1Service, name: string, namespace: string): Record<string, string> {
  const sel = svc.spec?.selector
  // An empty matchLabels selects ALL pods in the namespace: a policy meant
  // for one service would silently become namespace-wide.
  if (!sel || Object.keys(sel).length === 0) {
    throw new UserFacingError(`Service ${namespace}/${name} não possui selector: não é possível criar política restrita a ele`)
  }
  return sel as Record<string, string>
}

export interface ResolvedWorkload {
  selector: Record<string, string>
  // Non-null only when a real Service matched (the first tier below), letting
  // a caller that also needs port resolution reuse this same lookup instead
  // of assuming a Service exists and re-fetching it.
  service: k8s.V1Service | null
}

// Resolves a workload name to its pod selector (and, if one exists, its
// Service), trying, in order, the resources that could plausibly own it:
// Service, Deployment, StatefulSet, DaemonSet, each tried only if the
// previous one 404s (any other error propagates immediately, never silently
// falls through). A workload that never receives inbound traffic (a queue
// worker, a cron job) often has no Service at all, so requiring one (the
// old behavior) made it impossible to create any policy naming that
// workload, as either the source OR the destination (e.g. a flow
// discovered straight from a StatefulSet pod like "kafka-0", whose
// StatefulSet is actually named "kafka" without the ordinal, so it doesn't
// match by Service name OR by StatefulSet name either).
// Last resort: no Service and no matching standard controller (a bare pod,
// a Job/CronJob-owned pod, or a custom controller): find a live pod whose
// normalized name matches and use its own identity labels (see
// isIdentityLabel in podIdentity.ts). This is a best-effort guess, not a
// guarantee: it's only reached when nothing more authoritative exists to ask.
export async function resolveWorkload(name: string, namespace: string): Promise<ResolvedWorkload> {
  try {
    const svc = await core.readNamespacedService({ name, namespace })
    return { selector: selectorOf(svc, name, namespace), service: svc }
  } catch (e) {
    if (getK8sStatus(e) !== 404) throw e
  }

  const controllerReaders: Array<() => Promise<k8s.V1Deployment | k8s.V1StatefulSet | k8s.V1DaemonSet>> = [
    () => apps.readNamespacedDeployment({ name, namespace }),
    () => apps.readNamespacedStatefulSet({ name, namespace }),
    () => apps.readNamespacedDaemonSet({ name, namespace }),
  ]
  for (const read of controllerReaders) {
    try {
      const workload = await read()
      const sel = workload.spec?.selector?.matchLabels
      if (sel && Object.keys(sel).length > 0) return { selector: sel, service: null }
    } catch (e) {
      if (getK8sStatus(e) !== 404) throw e
    }
  }

  const pods = await core.listNamespacedPod({ namespace })
  const match = pods.items.find(p => normalizeWorkload(p.metadata?.name ?? '') === name)
  if (!match) {
    throw new UserFacingError(`Não foi possível encontrar Service, Deployment, StatefulSet, DaemonSet ou Pod para "${namespace}/${name}"`)
  }
  const labels = identityLabels(match.metadata?.labels ?? {})
  if (Object.keys(labels).length === 0) {
    throw new UserFacingError(`Pod "${match.metadata?.name}" não tem labels suficientes para identificar "${namespace}/${name}" com segurança`)
  }
  return { selector: labels, service: null }
}

export async function resolvePodSelector(name: string, namespace: string): Promise<Record<string, string>> {
  return (await resolveWorkload(name, namespace)).selector
}

// Same as resolveTargetPortFromService, but for a destination resolved via
// resolveWorkload() that might not have a Service at all (any tier past the
// first one in resolveWorkload). A named targetPort can only be resolved by
// looking at a Service's own port mapping: without one there's nothing to
// resolve against, so the given port is used as-is. This is safe: unlike
// the manual "Criar política" UI (which only ever offers services, so a
// numeric port always maps through one), the port here can come from a
// live-observed Hubble flow, which is already the real, concrete port in
// use, never a named one needing resolution in the first place.
export async function resolveTargetPortMaybeService(svc: k8s.V1Service | null, namespace: string, servicePort: number): Promise<number> {
  return svc ? resolveTargetPortFromService(svc, namespace, servicePort) : servicePort
}

// Resolves the pod port for a given service port. Named targetPorts (e.g.
// "http") are resolved by inspecting containerPorts of the service's pods:
// falling back to the service port would allow the wrong port in the policy.
async function resolveTargetPortFromService(svc: k8s.V1Service, namespace: string, servicePort: number): Promise<number> {
  const svcName = svc.metadata?.name ?? ''
  const portDef = (svc.spec?.ports ?? []).find(p => p.port === servicePort)
  if (!portDef || portDef.targetPort === undefined) return servicePort
  const target = portDef.targetPort as unknown
  if (typeof target === 'number') return target
  const numeric = parseInt(target as string, 10)
  if (!isNaN(numeric)) return numeric

  const selector = svc.spec?.selector ?? {}
  const labelSelector = Object.entries(selector).map(([k, v]) => `${k}=${v}`).join(',')
  if (labelSelector) {
    try {
      const pods = await core.listNamespacedPod({ namespace, labelSelector })
      for (const pod of pods.items) {
        for (const c of pod.spec?.containers ?? []) {
          const cp = (c.ports ?? []).find(cp => cp.name === target)
          if (cp) return cp.containerPort
        }
      }
    } catch (e) {
      throw new UserFacingError(`Não foi possível listar pods para resolver a targetPort nomeada "${target}" de ${namespace}/${svcName}: verifique se o RBAC inclui "pods" (${getK8sStatus(e) ?? 'erro'})`, 500)
    }
  }
  throw new UserFacingError(`Não foi possível resolver a targetPort nomeada "${target}" do service ${namespace}/${svcName}: nenhum pod com containerPort correspondente`)
}

// ── Auto-detect policy metadata from raw K8s spec ──────────────────────────
function detectPolicyMeta(spec: k8s.V1NetworkPolicySpec): {
  policyType: 'allow' | 'allow-egress' | 'allow-namespace' | 'restrict-ingress' | 'restrict-egress'
  srcNamespace: string
  targetPort: number
} {
  const policyTypes  = spec.policyTypes ?? []
  const hasIngress   = policyTypes.includes('Ingress')
  const hasEgress    = policyTypes.includes('Egress')
  const ingressRules = spec.ingress ?? []
  const egressRules  = spec.egress  ?? []

  if (hasIngress && ingressRules.length === 0)
    return { policyType: 'restrict-ingress', srcNamespace: '', targetPort: 0 }
  if (hasEgress && egressRules.length === 0)
    return { policyType: 'restrict-egress', srcNamespace: '', targetPort: 0 }

  if (hasIngress && ingressRules.length > 0) {
    const from   = ingressRules[0]?._from?.[0]
    const srcNs  = (from?.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] as string | undefined) ?? ''
    const port   = parseIntOrString(ingressRules[0]?.ports?.[0]?.port, 0)
    const isNsOnly = !!from?.namespaceSelector && !from?.podSelector
    return { policyType: isNsOnly ? 'allow-namespace' : 'allow', srcNamespace: srcNs, targetPort: port }
  }

  if (hasEgress && egressRules.length > 0) {
    const to    = egressRules[0]?.to?.[0]
    const dstNs = (to?.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] as string | undefined) ?? ''
    const port  = parseIntOrString(egressRules[0]?.ports?.[0]?.port, 0)
    return { policyType: 'allow-egress', srcNamespace: dstNs, targetPort: port }
  }

  return { policyType: 'allow', srcNamespace: '', targetPort: 0 }
}

export async function listNamespaceNames(): Promise<Set<string>> {
  const list = await core.listNamespace()
  return new Set(list.items.map(ns => ns.metadata!.name!))
}

export async function listNetworkPolicies(allPolicies = false): Promise<NetworkPolicyInfo[]> {
  const labelSel = allPolicies ? undefined : `managed-by=${MANAGED_BY}`
  const list = await networking.listNetworkPolicyForAllNamespaces(
    labelSel ? { labelSelector: labelSel } : undefined
  )

  const result = list.items.map((p: k8s.V1NetworkPolicy) => {
    const labels = p.metadata?.labels ?? {}
    const managed = labels['managed-by'] === MANAGED_BY
    const spec = p.spec!
    const podSel = (spec.podSelector?.matchLabels ?? {}) as Record<string, string>

    if (managed) {
      const policyType = (labels['floodgate-policy-type'] ?? 'allow') as NetworkPolicyInfo['policy_type']
      const rawPorts = policyType === 'allow-egress' || policyType === 'cidr-egress'
        ? (spec.egress?.find((r: k8s.V1NetworkPolicyEgressRule) => r.to && r.to.length > 0)?.ports ?? [])
        : (spec.ingress?.[0]?.ports ?? [])
      const specPorts: PortSpec[] = (rawPorts as k8s.V1NetworkPolicyPort[])
        .filter(pp => pp.port !== undefined && pp.port !== 53)
        .map(pp => ({
          port: Number(pp.port), protocol: (pp.protocol ?? 'TCP') as 'TCP' | 'UDP' | 'SCTP',
          ...(pp.endPort !== undefined ? { endPort: Number(pp.endPort) } : {}),
        }))
      const firstPort = parseInt(labels['target-port'] ?? '0') || 0
      const dst_ports = specPorts.length > 0 ? specPorts : (firstPort ? [{ port: firstPort, protocol: 'TCP' as const }] : [])
      return {
        name: p.metadata!.name!,
        namespace: p.metadata!.namespace!,
        src_workload: labels['source-workload'] ?? '',
        src_namespace: labels['source-namespace'] ?? '',
        dst_service: labels['target-service'] ?? '',
        dst_port: firstPort,
        dst_ports,
        policy_type: policyType,
        managed: true,
        adopted: labels['floodgate-adopted'] === 'true',
        policy_types: (spec.policyTypes ?? []) as string[],
        pod_selector: podSel,
        ingress_count: spec.ingress?.length ?? 0,
        egress_count: spec.egress?.length ?? 0,
        created_at: p.metadata?.creationTimestamp?.toISOString(),
      } satisfies NetworkPolicyInfo
    } else {
      return {
        name: p.metadata!.name!,
        namespace: p.metadata!.namespace!,
        src_workload: '',
        src_namespace: '',
        dst_service: '',
        dst_port: 0,
        dst_ports: [],
        policy_type: 'external' as const,
        managed: false,
        policy_types: (spec.policyTypes ?? []) as string[],
        pod_selector: podSel,
        ingress_count: spec.ingress?.length ?? 0,
        egress_count: spec.egress?.length ?? 0,
        created_at: p.metadata?.creationTimestamp?.toISOString(),
      } satisfies NetworkPolicyInfo
    }
  })

  // Live K8s state is unaffected by write mode either way: floodgate never
  // writes there directly under GitOps, but ArgoCD still does, so `result`
  // above is already accurate live state regardless of mode. Only the
  // sync_status merge (what's pending ArgoCD vs already applied) is
  // GitOps-specific: see k8s-gitops.ts's mergeGitSyncStatus.
  if (getWriteMode() === 'gitops') return mergeGitSyncStatus(result)
  return result
}

export async function createNetworkPolicy(req: CreatePolicyRequest): Promise<NetworkPolicyInfo> {
  if (getWriteMode() === 'gitops') return createNetworkPolicyViaGit(req)
  const [srcSelector, dst] = await Promise.all([
    resolvePodSelector(req.src_workload, req.src_namespace),
    resolveWorkload(req.dst_service, req.dst_namespace),
  ])
  const dstSelector = dst.selector

  // A ranged port (endPort) has no single Service port to resolve against:
  // skip resolution for it and match the raw range directly on the pod.
  const resolvedPorts = await Promise.all(
    req.dst_ports.map(async ps => ps.endPort !== undefined
      ? { port: ps.port, endPort: ps.endPort, protocol: ps.protocol as 'TCP' | 'UDP' | 'SCTP' }
      : { port: await resolveTargetPortMaybeService(dst.service, req.dst_namespace, ps.port), protocol: ps.protocol as 'TCP' | 'UDP' | 'SCTP' }
    )
  )

  const firstPort = req.dst_ports[0]?.port ?? 0
  const policyName = sanitizeK8sName(`floodgate-allow-${req.src_workload}-${req.src_namespace}-to-${req.dst_service}`)

  const body: k8s.V1NetworkPolicy = {
    metadata: {
      name: policyName,
      namespace: req.dst_namespace,
      labels: {
        'managed-by': MANAGED_BY,
        'floodgate-policy-type': 'allow',
        'source-workload': sanitizeLabelValue(req.src_workload),
        'source-namespace': sanitizeLabelValue(req.src_namespace),
        'target-service': sanitizeLabelValue(req.dst_service),
        'target-port': String(firstPort),
      },
    },
    spec: {
      podSelector: { matchLabels: dstSelector },
      policyTypes: ['Ingress'],
      ingress: [{
        _from: [{
          namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': req.src_namespace } },
          podSelector: { matchLabels: srcSelector },
        }],
        ports: resolvedPorts,
      }],
    },
  }

  let created: k8s.V1NetworkPolicy
  try {
    created = await networking.createNamespacedNetworkPolicy({ namespace: req.dst_namespace, body })
  } catch (e: unknown) {
    const status = getK8sStatus(e)
    if (status === 409) {
      created = await networking.replaceNamespacedNetworkPolicy({ name: policyName, namespace: req.dst_namespace, body })
    } else throw e
  }
  return {
    name: created.metadata!.name!,
    namespace: created.metadata!.namespace!,
    src_workload: req.src_workload,
    src_namespace: req.src_namespace,
    dst_service: req.dst_service,
    dst_port: firstPort,
    dst_ports: resolvedPorts,
    policy_type: 'allow',
    managed: true,
    policy_types: ['Ingress'],
    pod_selector: {},
    ingress_count: 1,
    egress_count: 0,
    created_at: created.metadata?.creationTimestamp?.toISOString(),
  }
}

export async function createEgressNetworkPolicy(req: CreatePolicyRequest): Promise<NetworkPolicyInfo> {
  if (getWriteMode() === 'gitops') return createEgressNetworkPolicyViaGit(req)
  const [srcSelector, dst] = await Promise.all([
    resolvePodSelector(req.src_workload, req.src_namespace),
    resolveWorkload(req.dst_service, req.dst_namespace),
  ])
  const dstSelector = dst.selector

  const resolvedPorts = await Promise.all(
    req.dst_ports.map(async ps => ps.endPort !== undefined
      ? { port: ps.port, endPort: ps.endPort, protocol: ps.protocol as 'TCP' | 'UDP' | 'SCTP' }
      : { port: await resolveTargetPortMaybeService(dst.service, req.dst_namespace, ps.port), protocol: ps.protocol as 'TCP' | 'UDP' | 'SCTP' }
    )
  )
  const firstPort = req.dst_ports[0]?.port ?? 0

  const policyName = sanitizeK8sName(`floodgate-egress-${req.src_workload}-to-${req.dst_service}`)

  const body: k8s.V1NetworkPolicy = {
    metadata: {
      name: policyName,
      namespace: req.src_namespace,
      labels: {
        'managed-by': MANAGED_BY,
        'floodgate-policy-type': 'allow-egress',
        'source-workload': sanitizeLabelValue(req.src_workload),
        'source-namespace': sanitizeLabelValue(req.src_namespace),
        'target-service': sanitizeLabelValue(req.dst_service),
        'target-port': String(firstPort),
      },
    },
    spec: {
      podSelector: { matchLabels: srcSelector },
      policyTypes: ['Egress'],
      egress: [
        {
          to: [{
            namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': req.dst_namespace } },
            podSelector: { matchLabels: dstSelector },
          }],
          ports: resolvedPorts,
        },
        { ports: [{ protocol: 'UDP', port: 53 as unknown as number }, { protocol: 'TCP', port: 53 as unknown as number }] },
      ],
    },
  }

  let created: k8s.V1NetworkPolicy
  try {
    created = await networking.createNamespacedNetworkPolicy({ namespace: req.src_namespace, body })
  } catch (e: unknown) {
    const status = getK8sStatus(e)
    if (status === 409) {
      created = await networking.replaceNamespacedNetworkPolicy({ name: policyName, namespace: req.src_namespace, body })
    } else throw e
  }
  return {
    name: created.metadata!.name!,
    namespace: created.metadata!.namespace!,
    src_workload: req.src_workload,
    src_namespace: req.src_namespace,
    dst_service: req.dst_service,
    dst_port: firstPort,
    dst_ports: resolvedPorts,
    policy_type: 'allow-egress',
    managed: true,
    policy_types: ['Egress'],
    pod_selector: {},
    ingress_count: 0,
    egress_count: 1,
    created_at: created.metadata?.creationTimestamp?.toISOString(),
  }
}

export async function createRestrictPolicy(req: RestrictPolicyRequest): Promise<NetworkPolicyInfo> {
  if (getWriteMode() === 'gitops') return createRestrictPolicyViaGit(req)
  const svcSelector = await resolvePodSelector(req.service_name, req.namespace)
  const policyType = `restrict-${req.direction}` as 'restrict-ingress' | 'restrict-egress'
  const policyName = sanitizeK8sName(`floodgate-restrict-${req.direction}-${req.service_name}`)

  const spec: k8s.V1NetworkPolicySpec = {
    podSelector: { matchLabels: svcSelector },
    policyTypes: [req.direction === 'ingress' ? 'Ingress' : 'Egress'],
  }
  if (req.direction === 'ingress') spec.ingress = []
  else spec.egress = []

  const body: k8s.V1NetworkPolicy = {
    metadata: {
      name: policyName,
      namespace: req.namespace,
      labels: {
        'managed-by': MANAGED_BY,
        'floodgate-policy-type': policyType,
        'target-service': sanitizeLabelValue(req.service_name),
        'source-workload': '',
        'source-namespace': '',
        'target-port': '0',
      },
    },
    spec,
  }

  let created: k8s.V1NetworkPolicy
  try {
    created = await networking.createNamespacedNetworkPolicy({ namespace: req.namespace, body })
  } catch (e: unknown) {
    if (getK8sStatus(e) !== 409) throw e
    created = await networking.replaceNamespacedNetworkPolicy({ name: policyName, namespace: req.namespace, body })
  }
  return {
    name: created.metadata!.name!,
    namespace: created.metadata!.namespace!,
    src_workload: '',
    src_namespace: '',
    dst_service: req.service_name,
    dst_port: 0,
    dst_ports: [],
    policy_type: policyType,
    managed: true,
    policy_types: spec.policyTypes as string[],
    pod_selector: {},
    ingress_count: 0,
    egress_count: 0,
    created_at: created.metadata?.creationTimestamp?.toISOString(),
  }
}

export async function deleteNetworkPolicy(namespace: string, name: string): Promise<void> {
  if (getWriteMode() === 'gitops') return deleteNetworkPolicyViaGit(namespace, name)
  await networking.deleteNamespacedNetworkPolicy({ name, namespace })
}

// Only for "apagar todas" (DELETE /api/networkpolicies): every other
// delete path still goes through deleteNetworkPolicy() above one at a
// time, on purpose (a single accidental/adopted policy failing to delete
// shouldn't block others). In GitOps mode this batches into ONE commit
// (deleteNetworkPoliciesBatchViaGit) instead of N, same all-or-nothing
// semantics as any single commit: either every file is removed or the
// thrown error means none were. Direct mode keeps today's best-effort
// per-policy behavior (each K8s API call can fail independently; no
// "commit" to batch there anyway).
export async function deleteNetworkPoliciesBatch(
  policies: Array<{ namespace: string; name: string }>,
): Promise<{ succeeded: Array<{ namespace: string; name: string }>; failures: string[] }> {
  if (policies.length === 0) return { succeeded: [], failures: [] }
  if (getWriteMode() === 'gitops') {
    await deleteNetworkPoliciesBatchViaGit(policies)
    return { succeeded: policies, failures: [] }
  }
  const succeeded: Array<{ namespace: string; name: string }> = []
  const failures: string[] = []
  for (const p of policies) {
    try {
      await networking.deleteNamespacedNetworkPolicy({ name: p.name, namespace: p.namespace })
      succeeded.push(p)
    } catch (e) {
      failures.push(`${p.namespace}/${p.name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return { succeeded, failures }
}

export async function patchNetworkPolicyPort(
  namespace: string, name: string, newPorts: Array<{ port: number; protocol: 'TCP' | 'UDP' | 'SCTP'; endPort?: number }>,
): Promise<NetworkPolicyInfo> {
  if (getWriteMode() === 'gitops') return patchNetworkPolicyPortViaGit(namespace, name, newPorts)
  const existing = await networking.readNamespacedNetworkPolicy({ name, namespace })
  const labels = existing.metadata?.labels ?? {}
  const policyType = labels['floodgate-policy-type'] ?? 'allow'

  if (policyType !== 'allow' && policyType !== 'allow-egress') {
    throw new UserFacingError(`Tipo de policy "${policyType}" não suporta edição de porta`)
  }

  // Create/replace the new policy FIRST, then remove the old one only if the
  // name changed (adopted policies): deleting first would leave the workload
  // unprotected if the recreate fails midway.
  let result: NetworkPolicyInfo
  if (policyType === 'allow') {
    result = await createNetworkPolicy({
      src_workload: labels['source-workload'] ?? '',
      src_namespace: labels['source-namespace'] ?? '',
      dst_service: labels['target-service'] ?? '',
      dst_namespace: namespace,
      dst_ports: newPorts,
    })
  } else {
    const dstNs = (existing.spec?.egress?.[0]?.to?.[0]?.namespaceSelector
      ?.matchLabels?.['kubernetes.io/metadata.name'] as string | undefined) ?? ''
    result = await createEgressNetworkPolicy({
      src_workload: labels['source-workload'] ?? '',
      src_namespace: namespace,
      dst_service: labels['target-service'] ?? '',
      dst_namespace: dstNs,
      dst_ports: newPorts,
    })
  }

  if (result.name !== name) await deleteNetworkPolicy(namespace, name)
  return result
}

export async function createNamespaceIngressPolicy(req: {
  src_namespace: string
  dst_service: string
  dst_namespace: string
  dst_port: number
}): Promise<NetworkPolicyInfo> {
  if (getWriteMode() === 'gitops') return createNamespaceIngressPolicyViaGit(req)
  // One lookup instead of two: resolvePodSelector + resolveTargetPort used
  // to each independently try to fetch the same Service.
  const dst = await resolveWorkload(req.dst_service, req.dst_namespace)
  const dstSelector = dst.selector
  const podPort = await resolveTargetPortMaybeService(dst.service, req.dst_namespace, req.dst_port)

  const policyName = sanitizeK8sName(`floodgate-allow-ns-${req.src_namespace}-to-${req.dst_service}`)

  const body: k8s.V1NetworkPolicy = {
    metadata: {
      name: policyName,
      namespace: req.dst_namespace,
      labels: {
        'managed-by': MANAGED_BY,
        'floodgate-policy-type': 'allow-namespace',
        'source-workload': '',
        'source-namespace': sanitizeLabelValue(req.src_namespace),
        'target-service': sanitizeLabelValue(req.dst_service),
        'target-port': String(req.dst_port),
      },
    },
    spec: {
      podSelector: { matchLabels: dstSelector },
      policyTypes: ['Ingress'],
      ingress: [{
        _from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': req.src_namespace } } }],
        ports: [{ port: podPort, protocol: 'TCP' }],
      }],
    },
  }

  const created = await networking.createNamespacedNetworkPolicy({ namespace: req.dst_namespace, body })
  return {
    name: created.metadata!.name!,
    namespace: created.metadata!.namespace!,
    src_workload: '',
    src_namespace: req.src_namespace,
    dst_service: req.dst_service,
    dst_port: req.dst_port,
    dst_ports: [{ port: req.dst_port, protocol: 'TCP' as const }],
    policy_type: 'allow-namespace',
    managed: true,
    policy_types: ['Ingress'],
    pod_selector: {},
    ingress_count: 1,
    egress_count: 0,
    created_at: created.metadata?.creationTimestamp?.toISOString(),
  }
}

// One namespace-wide restrict policy (podSelector: {} = all pods, including
// ones with no Service in front of them, broader than createRestrictPolicy,
// which is scoped to a single service's selector). Deterministic name, fixed
// empty-deny spec, so re-creating it is always a no-op: a 409 just means the
// desired state already exists, not a conflict to resolve via replace.
export async function createNamespaceRestrictPolicy(
  namespace: string, direction: 'ingress' | 'egress'
): Promise<{ name: string; namespace: string; created: boolean }> {
  if (getWriteMode() === 'gitops') return createNamespaceRestrictPolicyViaGit(namespace, direction)
  const policyName = sanitizeK8sName(`floodgate-ns-deny-${direction}-${namespace}`)
  const policyType = `restrict-${direction}` as 'restrict-ingress' | 'restrict-egress'
  const spec: k8s.V1NetworkPolicySpec = {
    podSelector: {},
    policyTypes: [direction === 'ingress' ? 'Ingress' : 'Egress'],
  }
  if (direction === 'ingress') spec.ingress = []
  else spec.egress = []

  const body: k8s.V1NetworkPolicy = {
    metadata: {
      name: policyName,
      namespace,
      labels: {
        'managed-by': MANAGED_BY,
        'floodgate-policy-type': policyType,
        'source-workload': '',
        'source-namespace': '',
        'target-service': '',
        'target-port': '0',
      },
    },
    spec,
  }
  try {
    await networking.createNamespacedNetworkPolicy({ namespace, body })
    return { name: policyName, namespace, created: true }
  } catch (e) {
    // Only "already exists" is a no-op: RBAC/validation failures must surface
    if (getK8sStatus(e) === 409) return { name: policyName, namespace, created: false }
    throw e
  }
}

export async function isolateNamespace(req: IsolateNamespaceRequest): Promise<{ created: number; skipped: number }> {
  if (getWriteMode() === 'gitops') return isolateNamespaceViaGit(req)
  let created = 0, skipped = 0
  const directions: ('ingress' | 'egress')[] = req.direction === 'both' ? ['ingress', 'egress'] : [req.direction]

  // One namespace-wide deny policy per direction (podSelector: {} = all pods).
  // Existing per-service allow rules continue to work via K8s OR semantics.
  for (const dir of directions) {
    const r = await createNamespaceRestrictPolicy(req.namespace, dir)
    if (r.created) created++
    else skipped++
  }

  if (req.allow_intra_namespace) {
    for (const dir of directions) {
      const policyName = sanitizeK8sName(`floodgate-intra-${dir}-${req.namespace}`)
      const spec: k8s.V1NetworkPolicySpec = {
        podSelector: {},
        policyTypes: [dir === 'ingress' ? 'Ingress' : 'Egress'],
      }
      if (dir === 'ingress') {
        spec.ingress = [{ _from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': req.namespace } } }] }]
      } else {
        spec.egress = [
          { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': req.namespace } } }] },
          { ports: [{ protocol: 'UDP', port: 53 as unknown as number }, { protocol: 'TCP', port: 53 as unknown as number }] },
        ]
      }
      const body: k8s.V1NetworkPolicy = {
        metadata: {
          name: policyName,
          namespace: req.namespace,
          labels: {
            'managed-by': MANAGED_BY,
            'floodgate-policy-type': 'allow-intranamespace',
            'source-workload': '',
            'source-namespace': req.namespace.slice(0, 63),
            'target-service': '',
            'target-port': '0',
          },
        },
        spec,
      }
      try {
        await networking.createNamespacedNetworkPolicy({ namespace: req.namespace, body })
        created++
      } catch (e) {
        if (getK8sStatus(e) === 409) skipped++
        else throw e
      }
    }
  }

  if (req.allow_egress_internet && (req.direction === 'egress' || req.direction === 'both')) {
    const policyName = sanitizeK8sName(`floodgate-egress-internet-${req.namespace}`)
    const body: k8s.V1NetworkPolicy = {
      metadata: {
        name: policyName,
        namespace: req.namespace,
        labels: {
          'managed-by': MANAGED_BY,
          'floodgate-policy-type': 'allow-egress',
          'source-workload': '',
          'source-namespace': req.namespace.slice(0, 63),
          'target-service': 'internet',
          'target-port': '80',
        },
      },
      spec: {
        podSelector: {},
        policyTypes: ['Egress'],
        egress: [
          {
            to: [{
              ipBlock: {
                cidr: '0.0.0.0/0',
                except: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10'],
              },
            }],
            ports: [
              { protocol: 'TCP', port: 80 as unknown as number },
              { protocol: 'TCP', port: 443 as unknown as number },
            ],
          },
          // Allow DNS so pods can resolve internet hostnames
          { ports: [{ protocol: 'UDP', port: 53 as unknown as number }, { protocol: 'TCP', port: 53 as unknown as number }] },
        ],
      },
    }
    try {
      await networking.createNamespacedNetworkPolicy({ namespace: req.namespace, body })
      created++
    } catch (e) {
      // Only "already exists" counts as skipped: RBAC/validation failures must surface
      if (getK8sStatus(e) === 409) skipped++
      else throw e
    }
  }

  return { created, skipped }
}

export async function createCidrPolicy(req: CidrPolicyRequest): Promise<NetworkPolicyInfo> {
  if (getWriteMode() === 'gitops') return createCidrPolicyViaGit(req)
  const { namespace, service_name, cidr, except, dst_ports, direction } = req

  const podSelector = service_name ? await resolvePodSelector(service_name, namespace) : {}

  const kPorts = (dst_ports?.length ?? 0) > 0
    ? dst_ports!.map(p => ({
        protocol: p.protocol as string, port: p.port as unknown as number,
        ...(p.endPort !== undefined ? { endPort: p.endPort as unknown as number } : {}),
      }))
    : undefined

  const ipBlock: k8s.V1IPBlock = { cidr, ...(except?.length ? { except } : {}) }
  const policyType = `cidr-${direction}` as 'cidr-ingress' | 'cidr-egress'
  const safeCidr = cidr.replace(/\//g, '-').replace(/\./g, '-')
  const policyName = sanitizeK8sName(`floodgate-cidr-${direction}-${safeCidr}${service_name ? `-${service_name}` : ''}`)

  const spec: k8s.V1NetworkPolicySpec = {
    podSelector: { matchLabels: podSelector },
    policyTypes: [direction === 'ingress' ? 'Ingress' : 'Egress'],
    ...(direction === 'ingress'
      ? { ingress: [{ _from: [{ ipBlock }], ...(kPorts ? { ports: kPorts } : {}) }] }
      : { egress:  [{ to:    [{ ipBlock }], ...(kPorts ? { ports: kPorts } : {}) }] }),
  }

  const labels: Record<string, string> = {
    'managed-by': MANAGED_BY,
    'floodgate-policy-type': policyType,
    'target-service': service_name ?? '',
    'target-port': String(dst_ports?.[0]?.port ?? 0),
    'source-workload': '',
    'source-namespace': '',
  }

  const body = { metadata: { name: policyName, namespace, labels }, spec }

  try {
    await networking.createNamespacedNetworkPolicy({ namespace, body })
  } catch (e: unknown) {
    if (getK8sStatus(e) !== 409) throw e
    await networking.replaceNamespacedNetworkPolicy({ namespace, name: policyName, body })
  }

  return {
    name: policyName, namespace, managed: true, policy_type: policyType,
    src_workload: '', src_namespace: '',
    dst_service: service_name ?? '', dst_port: 0,
    dst_ports: dst_ports ?? [], policy_types: [direction === 'ingress' ? 'Ingress' : 'Egress'],
    pod_selector: podSelector, ingress_count: 0, egress_count: 0,
  }
}

export async function previewPolicyYAML(
  req: CreatePolicyRequest & { dst_cidr?: string; cidr_except?: string[] },
  direction: 'ingress' | 'egress' | 'both',
): Promise<string> {
  // A CIDR-shaped request (internet-bound flows, or the CIDR creation form)
  // has no real dst Service/workload to resolve: req.dst_service here is
  // the SOURCE-side workload the policy's podSelector scopes to (mirrors
  // applyDraft()'s dst_cidr handling: dst_namespace/dst_service double as
  // the policy's own namespace/service_name for a CIDR policy). Preview-only
  // YAML, so `from`/`to` use the real K8s API field name directly: no need
  // for the `_from` workaround createCidrPolicy() uses to satisfy the
  // @kubernetes/client-node model's serializer.
  if (req.dst_cidr) {
    const cidrDirection = direction === 'ingress' ? 'ingress' : 'egress'
    const podSelector = req.dst_service ? await resolvePodSelector(req.dst_service, req.src_namespace) : {}
    const kPorts = req.dst_ports.length > 0
      ? req.dst_ports.map(p => ({
          protocol: p.protocol as string, port: p.port as unknown as number,
          ...(p.endPort !== undefined ? { endPort: p.endPort as unknown as number } : {}),
        }))
      : undefined
    const ipBlock = { cidr: req.dst_cidr, ...(req.cidr_except?.length ? { except: req.cidr_except } : {}) }
    const policyType = `cidr-${cidrDirection}`
    const safeCidr = req.dst_cidr.replace(/\//g, '-').replace(/\./g, '-')
    const policyName = sanitizeK8sName(`floodgate-cidr-${cidrDirection}-${safeCidr}${req.dst_service ? `-${req.dst_service}` : ''}`)
    const doc = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: policyName,
        namespace: req.src_namespace,
        labels: {
          'managed-by': MANAGED_BY, 'floodgate-policy-type': policyType,
          'target-service': req.dst_service ?? '', 'target-port': String(req.dst_ports?.[0]?.port ?? 0),
          'source-workload': '', 'source-namespace': '',
        },
      },
      spec: {
        podSelector: { matchLabels: podSelector },
        policyTypes: [cidrDirection === 'ingress' ? 'Ingress' : 'Egress'],
        ...(cidrDirection === 'ingress'
          ? { ingress: [{ from: [{ ipBlock }], ...(kPorts ? { ports: kPorts } : {}) }] }
          : { egress: [{ to: [{ ipBlock }], ...(kPorts ? { ports: kPorts } : {}) }] }),
      },
    }
    return yaml.dump(doc, { lineWidth: -1 })
  }

  const [srcSelector, dst] = await Promise.all([
    resolvePodSelector(req.src_workload, req.src_namespace),
    resolveWorkload(req.dst_service, req.dst_namespace),
  ])
  const dstSelector = dst.selector

  const resolvedPorts = await Promise.all(
    req.dst_ports.map(async ps => ps.endPort !== undefined
      ? { port: ps.port, endPort: ps.endPort, protocol: ps.protocol }
      : { port: await resolveTargetPortMaybeService(dst.service, req.dst_namespace, ps.port), protocol: ps.protocol }
    )
  )

  const docs: object[] = []
  const firstPort = req.dst_ports[0]?.port ?? 0
  const commonLabels = {
    'source-workload': sanitizeLabelValue(req.src_workload),
    'source-namespace': sanitizeLabelValue(req.src_namespace),
    'target-service': sanitizeLabelValue(req.dst_service),
    'target-port': String(firstPort),
  }

  // Must mirror createNetworkPolicy / createEgressNetworkPolicy exactly:
  // this YAML is what reviewers approve.
  if (direction === 'ingress' || direction === 'both') {
    docs.push({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: sanitizeK8sName(`floodgate-allow-${req.src_workload}-${req.src_namespace}-to-${req.dst_service}`),
        namespace: req.dst_namespace,
        labels: { 'managed-by': 'floodgate', 'floodgate-policy-type': 'allow', ...commonLabels },
      },
      spec: {
        podSelector: { matchLabels: dstSelector },
        policyTypes: ['Ingress'],
        ingress: [{ from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': req.src_namespace } }, podSelector: { matchLabels: srcSelector } }], ports: resolvedPorts }],
      },
    })
  }

  if (direction === 'egress' || direction === 'both') {
    docs.push({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: sanitizeK8sName(`floodgate-egress-${req.src_workload}-to-${req.dst_service}`),
        namespace: req.src_namespace,
        labels: { 'managed-by': 'floodgate', 'floodgate-policy-type': 'allow-egress', ...commonLabels },
      },
      spec: {
        podSelector: { matchLabels: srcSelector },
        policyTypes: ['Egress'],
        egress: [
          { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': req.dst_namespace } }, podSelector: { matchLabels: dstSelector } }], ports: resolvedPorts },
          // DNS rule included by createEgressNetworkPolicy
          { ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] },
        ],
      },
    })
  }

  return docs.map(d => yaml.dump(d, { lineWidth: -1 })).join('---\n')
}

export async function getPolicyYAML(namespace: string, name: string): Promise<string> {
  if (getWriteMode() === 'gitops') return getPolicyYAMLViaGit(namespace, name)
  const policy = await networking.readNamespacedNetworkPolicy({ name, namespace })
  const clean = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: policy.metadata?.name,
      namespace: policy.metadata?.namespace,
      labels: policy.metadata?.labels,
    },
    spec: yamlSafeSpec(policy.spec),
  }
  return yaml.dump(clean, { lineWidth: -1 })
}

export async function applyPolicyYAML(namespace: string, yamlStr: string): Promise<void> {
  if (getWriteMode() === 'gitops') return applyPolicyYAMLViaGit(namespace, yamlStr)
  const policy = yaml.load(yamlStr) as k8s.V1NetworkPolicy
  try {
    await networking.createNamespacedNetworkPolicy({ namespace, body: policy })
  } catch (e: unknown) {
    const status = getK8sStatus(e)
    if (status === 409) {
      await networking.replaceNamespacedNetworkPolicy({ name: policy.metadata!.name!, namespace, body: policy })
    } else throw e
  }
}

export async function adoptPolicy(
  namespace: string,
  name: string,
  policyTypeOverride?: string,
): Promise<string> {
  const policy = await networking.readNamespacedNetworkPolicy({ name, namespace })

  if (policy.metadata?.labels?.['managed-by'] === MANAGED_BY) {
    throw new Error('Esta policy já é gerenciada pelo Floodgate')
  }

  const detected   = detectPolicyMeta(policy.spec!)
  const policyType = policyTypeOverride ?? detected.policyType

  policy.metadata = policy.metadata ?? {}
  policy.metadata.labels = {
    ...(policy.metadata.labels ?? {}),
    'managed-by':            MANAGED_BY,
    'floodgate-policy-type': policyType,
    'floodgate-adopted':     'true',
    'source-workload':       '',
    'source-namespace':      detected.srcNamespace,
    'target-service':        '',
    'target-port':           String(detected.targetPort),
  }

  // The object isn't tracked in git yet (it wasn't managed until this call),
  // so the read above is unavoidably live either way: only the final
  // persist step differs by mode. See k8s-gitops.ts's adoptPolicyViaGit.
  if (getWriteMode() === 'gitops') return adoptPolicyViaGit(policy)

  const updated = await networking.replaceNamespacedNetworkPolicy({ name, namespace, body: policy })
  const clean = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name:      updated.metadata?.name,
      namespace: updated.metadata?.namespace,
      labels:    updated.metadata?.labels,
    },
    spec: yamlSafeSpec(updated.spec),
  }
  return yaml.dump(clean, { lineWidth: -1 })
}

export async function unadoptPolicy(namespace: string, name: string): Promise<void> {
  if (getWriteMode() === 'gitops') return unadoptPolicyViaGit(namespace, name)
  const policy = await networking.readNamespacedNetworkPolicy({ name, namespace })

  if (policy.metadata?.labels) {
    for (const key of [
      'managed-by', 'floodgate-policy-type', 'floodgate-adopted',
      'source-workload', 'source-namespace', 'target-service', 'target-port',
    ]) delete policy.metadata.labels[key]
  }

  await networking.replaceNamespacedNetworkPolicy({ name, namespace, body: policy })
}

// Goes through listNetworkPolicies() + getPolicyYAML() (both already
// dispatch on WRITE_MODE) instead of reading the K8s API directly, unlike
// this function used to. Reading live only meant that, under GitOps, a
// policy already committed to git but not yet synced by ArgoCD
// (sync_status 'pending_argocd') was silently missing from the export:
// no error, no indication anything was left out, just fewer documents
// than policies that actually exist. getPolicyYAML() itself already
// switches to reading the git file for exactly that case.
export async function exportManagedPoliciesYAML(): Promise<string> {
  const managed = (await listNetworkPolicies(false)).filter(p => p.managed)
  if (managed.length === 0) return '# Nenhuma NetworkPolicy gerenciada encontrada\n'

  const docs = await Promise.all(managed.map(async p => {
    try {
      return await getPolicyYAML(p.namespace, p.name)
    } catch (e) {
      console.error(`[floodgate] exportManagedPoliciesYAML: falha ao ler ${p.namespace}/${p.name}, pulando esta entrada:`, e)
      return null
    }
  }))
  return docs.filter((d): d is string => d !== null).join('---\n')
}

export async function checkHubbleRelayReady(): Promise<boolean> {
  try {
    const ep = await core.readNamespacedEndpoints({ name: 'hubble-relay', namespace: 'kube-system' })
    return ep.subsets?.some(s => (s.addresses?.length ?? 0) > 0) ?? false
  } catch {
    return false
  }
}
