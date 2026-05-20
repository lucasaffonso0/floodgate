import 'server-only'
import * as k8s from '@kubernetes/client-node'
import yaml from 'js-yaml'
import type { ServiceInfo, NetworkPolicyInfo, CreatePolicyRequest, PortSpec, RestrictPolicyRequest, IsolateNamespaceRequest } from '@/types'

const MANAGED_BY = 'floodgate'

const kc = new k8s.KubeConfig()
kc.loadFromDefault()

const core = kc.makeApiClient(k8s.CoreV1Api)
const networking = kc.makeApiClient(k8s.NetworkingV1Api)

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

async function getServiceSelector(name: string, namespace: string): Promise<Record<string, string>> {
  const svc = await core.readNamespacedService({ name, namespace })
  return (svc.spec?.selector ?? {}) as Record<string, string>
}

async function resolveTargetPort(svcName: string, namespace: string, servicePort: number): Promise<number> {
  const svc = await core.readNamespacedService({ name: svcName, namespace })
  for (const p of svc.spec?.ports ?? []) {
    if (p.port === servicePort) return parseIntOrString(p.targetPort, servicePort)
  }
  return servicePort
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

export async function listNetworkPolicies(allPolicies = false): Promise<NetworkPolicyInfo[]> {
  const labelSel = allPolicies ? undefined : `managed-by=${MANAGED_BY}`
  const list = await networking.listNetworkPolicyForAllNamespaces(
    labelSel ? { labelSelector: labelSel } : undefined
  )

  return list.items.map((p: k8s.V1NetworkPolicy) => {
    const labels = p.metadata?.labels ?? {}
    const managed = labels['managed-by'] === MANAGED_BY
    const spec = p.spec!
    const podSel = (spec.podSelector?.matchLabels ?? {}) as Record<string, string>

    if (managed) {
      const policyType = (labels['floodgate-policy-type'] ?? 'allow') as NetworkPolicyInfo['policy_type']
      const rawPorts = policyType === 'allow-egress'
        ? (spec.egress?.find((r: k8s.V1NetworkPolicyEgressRule) => r.to && r.to.length > 0)?.ports ?? [])
        : (spec.ingress?.[0]?.ports ?? [])
      const specPorts: PortSpec[] = (rawPorts as k8s.V1NetworkPolicyPort[])
        .filter(pp => pp.port !== undefined && pp.port !== 53)
        .map(pp => ({ port: Number(pp.port), protocol: (pp.protocol ?? 'TCP') as 'TCP' | 'UDP' | 'SCTP' }))
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
}

export async function createNetworkPolicy(req: CreatePolicyRequest): Promise<NetworkPolicyInfo> {
  const [srcSelector, dstSelector] = await Promise.all([
    getServiceSelector(req.src_workload, req.src_namespace),
    getServiceSelector(req.dst_service, req.dst_namespace),
  ])

  const resolvedPorts = await Promise.all(
    req.dst_ports.map(async ps => ({
      port: await resolveTargetPort(req.dst_service, req.dst_namespace, ps.port),
      protocol: ps.protocol as 'TCP' | 'UDP' | 'SCTP',
    }))
  )

  const firstPort = req.dst_ports[0]?.port ?? 0
  const policyName = `floodgate-allow-${req.src_workload}-${req.src_namespace}-to-${req.dst_service}`.slice(0, 63)

  const body: k8s.V1NetworkPolicy = {
    metadata: {
      name: policyName,
      namespace: req.dst_namespace,
      labels: {
        'managed-by': MANAGED_BY,
        'floodgate-policy-type': 'allow',
        'source-workload': req.src_workload.slice(0, 63),
        'source-namespace': req.src_namespace.slice(0, 63),
        'target-service': req.dst_service.slice(0, 63),
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
  const [srcSelector, dstSelector] = await Promise.all([
    getServiceSelector(req.src_workload, req.src_namespace),
    getServiceSelector(req.dst_service, req.dst_namespace),
  ])

  const resolvedPorts = await Promise.all(
    req.dst_ports.map(async ps => ({
      port: await resolveTargetPort(req.dst_service, req.dst_namespace, ps.port),
      protocol: ps.protocol as 'TCP' | 'UDP' | 'SCTP',
    }))
  )
  const firstPort = req.dst_ports[0]?.port ?? 0

  const policyName = `floodgate-egress-${req.src_workload}-to-${req.dst_service}`.slice(0, 63)

  const body: k8s.V1NetworkPolicy = {
    metadata: {
      name: policyName,
      namespace: req.src_namespace,
      labels: {
        'managed-by': MANAGED_BY,
        'floodgate-policy-type': 'allow-egress',
        'source-workload': req.src_workload.slice(0, 63),
        'source-namespace': req.src_namespace.slice(0, 63),
        'target-service': req.dst_service.slice(0, 63),
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
  const svcSelector = await getServiceSelector(req.service_name, req.namespace)
  const policyType = `restrict-${req.direction}` as 'restrict-ingress' | 'restrict-egress'
  const policyName = `floodgate-restrict-${req.direction}-${req.service_name}`.slice(0, 63)

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
        'target-service': req.service_name.slice(0, 63),
        'source-workload': '',
        'source-namespace': '',
        'target-port': '0',
      },
    },
    spec,
  }

  const created = await networking.createNamespacedNetworkPolicy({ namespace: req.namespace, body })
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
  await networking.deleteNamespacedNetworkPolicy({ name, namespace })
}

export async function patchNetworkPolicyPort(
  namespace: string, name: string, newPorts: Array<{ port: number; protocol: 'TCP' | 'UDP' | 'SCTP' }>,
): Promise<NetworkPolicyInfo> {
  const existing = await networking.readNamespacedNetworkPolicy({ name, namespace })
  const labels = existing.metadata?.labels ?? {}
  const policyType = labels['floodgate-policy-type'] ?? 'allow'

  await deleteNetworkPolicy(namespace, name)

  if (policyType === 'allow') {
    return createNetworkPolicy({
      src_workload: labels['source-workload'] ?? '',
      src_namespace: labels['source-namespace'] ?? '',
      dst_service: labels['target-service'] ?? '',
      dst_namespace: namespace,
      dst_ports: newPorts,
    })
  }

  if (policyType === 'allow-egress') {
    const dstNs = (existing.spec?.egress?.[0]?.to?.[0]?.namespaceSelector
      ?.matchLabels?.['kubernetes.io/metadata.name'] as string | undefined) ?? ''
    return createEgressNetworkPolicy({
      src_workload: labels['source-workload'] ?? '',
      src_namespace: namespace,
      dst_service: labels['target-service'] ?? '',
      dst_namespace: dstNs,
      dst_ports: newPorts,
    })
  }

  throw new Error(`Tipo de policy "${policyType}" não suporta edição de porta`)
}

export async function createNamespaceIngressPolicy(req: {
  src_namespace: string
  dst_service: string
  dst_namespace: string
  dst_port: number
}): Promise<NetworkPolicyInfo> {
  const [dstSelector, podPort] = await Promise.all([
    getServiceSelector(req.dst_service, req.dst_namespace),
    resolveTargetPort(req.dst_service, req.dst_namespace, req.dst_port),
  ])

  const policyName = `floodgate-allow-ns-${req.src_namespace}-to-${req.dst_service}`.slice(0, 63)

  const body: k8s.V1NetworkPolicy = {
    metadata: {
      name: policyName,
      namespace: req.dst_namespace,
      labels: {
        'managed-by': MANAGED_BY,
        'floodgate-policy-type': 'allow-namespace',
        'source-workload': '',
        'source-namespace': req.src_namespace.slice(0, 63),
        'target-service': req.dst_service.slice(0, 63),
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

export async function isolateNamespace(req: IsolateNamespaceRequest): Promise<{ created: number; skipped: number }> {
  let created = 0, skipped = 0
  const directions: ('ingress' | 'egress')[] = req.direction === 'both' ? ['ingress', 'egress'] : [req.direction]

  // One namespace-wide deny policy per direction (podSelector: {} = all pods).
  // Existing per-service allow rules continue to work via K8s OR semantics.
  for (const dir of directions) {
    const policyName = `floodgate-ns-deny-${dir}-${req.namespace}`.slice(0, 63)
    const policyType = `restrict-${dir}` as 'restrict-ingress' | 'restrict-egress'
    const spec: k8s.V1NetworkPolicySpec = {
      podSelector: {},
      policyTypes: [dir === 'ingress' ? 'Ingress' : 'Egress'],
    }
    if (dir === 'ingress') spec.ingress = []
    else spec.egress = []

    const body: k8s.V1NetworkPolicy = {
      metadata: {
        name: policyName,
        namespace: req.namespace,
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
      await networking.createNamespacedNetworkPolicy({ namespace: req.namespace, body })
      created++
    } catch { skipped++ }
  }

  if (req.allow_intra_namespace) {
    for (const dir of directions) {
      const policyName = `floodgate-intra-${dir}-${req.namespace}`.slice(0, 63)
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
      } catch { skipped++ }
    }
  }

  if (req.allow_egress_internet && (req.direction === 'egress' || req.direction === 'both')) {
    const policyName = `floodgate-egress-internet-${req.namespace}`.slice(0, 63)
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
    } catch { skipped++ }
  }

  return { created, skipped }
}

export async function previewPolicyYAML(
  req: CreatePolicyRequest,
  direction: 'ingress' | 'egress' | 'both',
): Promise<string> {
  const [srcSelector, dstSelector] = await Promise.all([
    getServiceSelector(req.src_workload, req.src_namespace),
    getServiceSelector(req.dst_service, req.dst_namespace),
  ])

  const resolvedPorts = await Promise.all(
    req.dst_ports.map(async ps => ({
      port: await resolveTargetPort(req.dst_service, req.dst_namespace, ps.port),
      protocol: ps.protocol,
    }))
  )

  const docs: object[] = []

  if (direction === 'ingress' || direction === 'both') {
    docs.push({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: `floodgate-allow-${req.src_workload}-${req.src_namespace}-to-${req.dst_service}`.slice(0, 63),
        namespace: req.dst_namespace,
        labels: { 'managed-by': 'floodgate', 'floodgate-policy-type': 'allow' },
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
        name: `floodgate-egress-${req.src_workload}-to-${req.dst_service}`.slice(0, 63),
        namespace: req.src_namespace,
        labels: { 'managed-by': 'floodgate', 'floodgate-policy-type': 'allow-egress' },
      },
      spec: {
        podSelector: { matchLabels: srcSelector },
        policyTypes: ['Egress'],
        egress: [{ to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': req.dst_namespace } }, podSelector: { matchLabels: dstSelector } }], ports: resolvedPorts }],
      },
    })
  }

  return docs.map(d => yaml.dump(d, { lineWidth: -1 })).join('---\n')
}

export async function getPolicyYAML(namespace: string, name: string): Promise<string> {
  const policy = await networking.readNamespacedNetworkPolicy({ name, namespace })
  const clean = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: policy.metadata?.name,
      namespace: policy.metadata?.namespace,
      labels: policy.metadata?.labels,
    },
    spec: policy.spec,
  }
  return yaml.dump(clean, { lineWidth: -1 })
}

export async function applyPolicyYAML(namespace: string, yamlStr: string): Promise<void> {
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

  const updated = await networking.replaceNamespacedNetworkPolicy({ name, namespace, body: policy })
  const clean = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name:      updated.metadata?.name,
      namespace: updated.metadata?.namespace,
      labels:    updated.metadata?.labels,
    },
    spec: updated.spec,
  }
  return yaml.dump(clean, { lineWidth: -1 })
}

export async function unadoptPolicy(namespace: string, name: string): Promise<void> {
  const policy = await networking.readNamespacedNetworkPolicy({ name, namespace })

  if (policy.metadata?.labels) {
    for (const key of [
      'managed-by', 'floodgate-policy-type', 'floodgate-adopted',
      'source-workload', 'source-namespace', 'target-service', 'target-port',
    ]) delete policy.metadata.labels[key]
  }

  await networking.replaceNamespacedNetworkPolicy({ name, namespace, body: policy })
}

export async function exportManagedPoliciesYAML(): Promise<string> {
  const list = await networking.listNetworkPolicyForAllNamespaces(
    { labelSelector: `managed-by=${MANAGED_BY}` }
  )

  if (list.items.length === 0) return '# Nenhuma NetworkPolicy gerenciada encontrada\n'

  return list.items.map((p: k8s.V1NetworkPolicy) => {
    const clean = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: {
        name: p.metadata?.name,
        namespace: p.metadata?.namespace,
        labels: p.metadata?.labels,
      },
      spec: p.spec,
    }
    return yaml.dump(clean, { lineWidth: -1 })
  }).join('---\n')
}
