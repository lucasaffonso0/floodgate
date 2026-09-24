import 'server-only'
import * as k8s from '@kubernetes/client-node'
import yaml from 'js-yaml'
import { UserFacingError } from './api-helpers'
import {
  resolvePodSelector, resolveWorkload, resolveTargetPortMaybeService,
  sanitizeK8sName, sanitizeLabelValue, yamlSafeSpec, MANAGED_BY,
} from './k8s'
import {
  commitPolicyFiles as commitPolicyFilesRaw, readPolicyFile, listPolicyFilesWithContent,
  hasGitOpsCredentials, getLastKnownCommitAuthors, type GitFileOp,
} from './git'
import { startPendingOp, finishPendingOp, listPendingOps } from './gitopsPendingOps'
import { getGitOpsConfig } from './gitopsConfig'
import type {
  RestrictPolicyRequest, NetworkPolicyInfo, CreatePolicyRequest, NamespaceIngressRequest,
  CidrPolicyRequest, IsolateNamespaceRequest, PortSpec,
} from '@/types'

// GitOps counterparts of the write functions in k8s.ts, one per function,
// each matching its direct-mode sibling's spec-building and return shape
// exactly: never chasing a shared format across functions (see k8s.ts's
// desvio-aditivo comment at each call site for why). Writes a
// policies/<namespace>/<name>.yaml file and commits/pushes via git.ts
// instead of calling the K8s API.

function policyFilePath(namespace: string, name: string): string {
  return `${namespace}/${name}.yaml`
}

// Every write below goes through this instead of git.ts's commitPolicyFiles
// directly: it records each touched policy as "in flight" in
// gitops_pending_ops (persisted in SQLite) before the commit/push starts,
// and always clears it afterward (success or failure). The commit/push
// itself can take several real seconds over SSH; without this, a page
// reload mid-write had nothing telling it that item was still being worked
// on, so it just looked gone until the write settled.
async function commitPolicyFilesTracked(ops: GitFileOp[], commitMessage: string): Promise<{ commit: string }> {
  const keys = ops
    .map(op => {
      const match = op.path.match(/^(.+)\/([^/]+)\.yaml$/)
      if (!match) return null
      return { namespace: match[1], name: match[2], kind: (op.action === 'delete' ? 'delete' : 'apply') as 'apply' | 'delete' }
    })
    .filter((k): k is { namespace: string; name: string; kind: 'apply' | 'delete' } => k !== null)
  keys.forEach(k => startPendingOp(k.namespace, k.name, k.kind))
  try {
    return await commitPolicyFilesRaw(ops, commitMessage)
  } finally {
    keys.forEach(k => finishPendingOp(k.namespace, k.name))
  }
}

export async function createRestrictPolicyViaGit(req: RestrictPolicyRequest): Promise<NetworkPolicyInfo> {
  const svcSelector = await resolvePodSelector(req.service_name, req.namespace)
  const policyType = `restrict-${req.direction}` as 'restrict-ingress' | 'restrict-egress'
  const policyName = sanitizeK8sName(`floodgate-restrict-${req.direction}-${req.service_name}`)

  const spec: k8s.V1NetworkPolicySpec = {
    podSelector: { matchLabels: svcSelector },
    policyTypes: [req.direction === 'ingress' ? 'Ingress' : 'Egress'],
  }
  if (req.direction === 'ingress') spec.ingress = []
  else spec.egress = []

  const labels = {
    'managed-by': MANAGED_BY,
    'floodgate-policy-type': policyType,
    'target-service': sanitizeLabelValue(req.service_name),
    'source-workload': '',
    'source-namespace': '',
    'target-port': '0',
  }

  const doc = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name: policyName, namespace: req.namespace, labels },
    spec,
  }

  await commitPolicyFilesTracked(
    [{ action: 'write', path: policyFilePath(req.namespace, policyName), content: yaml.dump(doc, { lineWidth: -1 }) }],
    `floodgate: restrict-${req.direction} ${req.namespace}/${req.service_name}`,
  )

  return {
    name: policyName,
    namespace: req.namespace,
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
    created_at: new Date().toISOString(),
    sync_status: 'pending_argocd',
  }
}

export async function deleteNetworkPolicyViaGit(namespace: string, name: string): Promise<void> {
  await commitPolicyFilesTracked(
    [{ action: 'delete', path: policyFilePath(namespace, name) }],
    `floodgate: delete ${namespace}/${name}`,
  )
}

// "Apagar todas" (DELETE /api/networkpolicies) used to call
// deleteNetworkPolicyViaGit once per policy: N policies meant N separate
// commit+push round trips over SSH instead of one. Batches every removal
// into a single commit, same as isolateNamespaceViaGit already does for
// its own up-to-5-file write. All-or-nothing: if the push fails, nothing
// was removed (the caller sees the thrown error), rather than an earlier
// policy silently succeeding while a later one fails mid-batch.
export async function deleteNetworkPoliciesBatchViaGit(policies: Array<{ namespace: string; name: string }>): Promise<void> {
  if (policies.length === 0) return
  // A path already missing from the repo (e.g. already in sync_status
  // 'pending_delete' from an earlier action) makes applyFileOps() skip
  // that op silently, with no per-file result surfaced anywhere:
  // deleteNetworkPoliciesBatch (k8s.ts) used to report the whole batch as
  // succeeded regardless. Checking existence first, and logging what's
  // already gone, at least makes this visible instead of indistinguishable
  // from an actual delete having just happened. Still safe to keep
  // reporting these as "succeeded" to the caller either way: the git
  // file being gone means ArgoCD's own prune already owns removing
  // whatever's still live for it, independent of floodgate's tracking.
  const files = await listPolicyFilesWithContent()
  const existingPaths = new Set(files.map(f => f.path))
  const ops: GitFileOp[] = []
  for (const p of policies) {
    const path = policyFilePath(p.namespace, p.name)
    if (existingPaths.has(path)) {
      ops.push({ action: 'delete', path })
    } else {
      console.warn(`[gitops] deleteNetworkPoliciesBatchViaGit: ${path} já não existia no repositório, nada a apagar para esta entrada`)
    }
  }
  if (ops.length === 0) return
  await commitPolicyFilesTracked(ops, `floodgate: delete ${ops.length} policies`)
}

async function resolvePorts(dst: { service: k8s.V1Service | null }, dst_namespace: string, dst_ports: PortSpec[]) {
  return Promise.all(
    dst_ports.map(async ps => ps.endPort !== undefined
      ? { port: ps.port, endPort: ps.endPort, protocol: ps.protocol }
      : { port: await resolveTargetPortMaybeService(dst.service, dst_namespace, ps.port), protocol: ps.protocol }
    )
  )
}

export async function createNetworkPolicyViaGit(req: CreatePolicyRequest): Promise<NetworkPolicyInfo> {
  const [srcSelector, dst] = await Promise.all([
    resolvePodSelector(req.src_workload, req.src_namespace),
    resolveWorkload(req.dst_service, req.dst_namespace),
  ])
  const resolvedPorts = await resolvePorts(dst, req.dst_namespace, req.dst_ports)
  const firstPort = req.dst_ports[0]?.port ?? 0
  const policyName = sanitizeK8sName(`floodgate-allow-${req.src_workload}-${req.src_namespace}-to-${req.dst_service}`)

  const doc = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
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
      podSelector: { matchLabels: dst.selector },
      policyTypes: ['Ingress'],
      ingress: [{
        from: [{
          namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': req.src_namespace } },
          podSelector: { matchLabels: srcSelector },
        }],
        ports: resolvedPorts,
      }],
    },
  }

  await commitPolicyFilesTracked(
    [{ action: 'write', path: policyFilePath(req.dst_namespace, policyName), content: yaml.dump(doc, { lineWidth: -1 }) }],
    `floodgate: allow ${req.src_namespace}/${req.src_workload} -> ${req.dst_namespace}/${req.dst_service}`,
  )

  return {
    name: policyName,
    namespace: req.dst_namespace,
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
    created_at: new Date().toISOString(),
    sync_status: 'pending_argocd',
  }
}

export async function createEgressNetworkPolicyViaGit(req: CreatePolicyRequest): Promise<NetworkPolicyInfo> {
  const [srcSelector, dst] = await Promise.all([
    resolvePodSelector(req.src_workload, req.src_namespace),
    resolveWorkload(req.dst_service, req.dst_namespace),
  ])
  const resolvedPorts = await resolvePorts(dst, req.dst_namespace, req.dst_ports)
  const firstPort = req.dst_ports[0]?.port ?? 0
  const policyName = sanitizeK8sName(`floodgate-egress-${req.src_workload}-to-${req.dst_service}`)

  const doc = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
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
            podSelector: { matchLabels: dst.selector },
          }],
          ports: resolvedPorts,
        },
        { ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] },
      ],
    },
  }

  await commitPolicyFilesTracked(
    [{ action: 'write', path: policyFilePath(req.src_namespace, policyName), content: yaml.dump(doc, { lineWidth: -1 }) }],
    `floodgate: egress ${req.src_namespace}/${req.src_workload} -> ${req.dst_namespace}/${req.dst_service}`,
  )

  return {
    name: policyName,
    namespace: req.src_namespace,
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
    created_at: new Date().toISOString(),
    sync_status: 'pending_argocd',
  }
}

export async function createNamespaceIngressPolicyViaGit(req: NamespaceIngressRequest): Promise<NetworkPolicyInfo> {
  const dst = await resolveWorkload(req.dst_service, req.dst_namespace)
  const podPort = await resolveTargetPortMaybeService(dst.service, req.dst_namespace, req.dst_port)
  const policyName = sanitizeK8sName(`floodgate-allow-ns-${req.src_namespace}-to-${req.dst_service}`)

  const doc = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
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
      podSelector: { matchLabels: dst.selector },
      policyTypes: ['Ingress'],
      ingress: [{
        from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': req.src_namespace } } }],
        ports: [{ port: podPort, protocol: 'TCP' }],
      }],
    },
  }

  await commitPolicyFilesTracked(
    [{ action: 'write', path: policyFilePath(req.dst_namespace, policyName), content: yaml.dump(doc, { lineWidth: -1 }) }],
    `floodgate: allow namespace ${req.src_namespace} -> ${req.dst_namespace}/${req.dst_service}`,
  )

  return {
    name: policyName,
    namespace: req.dst_namespace,
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
    created_at: new Date().toISOString(),
    sync_status: 'pending_argocd',
  }
}

export async function createNamespaceRestrictPolicyViaGit(
  namespace: string, direction: 'ingress' | 'egress',
): Promise<{ name: string; namespace: string; created: boolean }> {
  const policyName = sanitizeK8sName(`floodgate-ns-deny-${direction}-${namespace}`)
  const policyType = `restrict-${direction}` as 'restrict-ingress' | 'restrict-egress'
  const spec: Record<string, unknown> = {
    podSelector: {},
    policyTypes: [direction === 'ingress' ? 'Ingress' : 'Egress'],
  }
  if (direction === 'ingress') spec.ingress = []
  else spec.egress = []

  const doc = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
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

  await commitPolicyFilesTracked(
    [{ action: 'write', path: policyFilePath(namespace, policyName), content: yaml.dump(doc, { lineWidth: -1 }) }],
    `floodgate: namespace-deny-${direction} ${namespace}`,
  )
  return { name: policyName, namespace, created: true }
}

// isolateNamespace() can write up to 3 files in one call (deny + intra +
// internet-egress), grouped into a SINGLE commit here (git.ts's
// commitPolicyFiles takes a batch precisely for this), not 3 competing
// commits. Mirrors isolateNamespace()'s three inline spec-building blocks
// exactly (deny via createNamespaceRestrictPolicy, the other two inline in
// isolateNamespace itself): kept as three inline blocks here too, rather
// than only wiring the desvio into createNamespaceRestrictPolicy, which
// would silently leave the intra/internet companion policies hitting the
// live K8s API under GitOps.
export async function isolateNamespaceViaGit(req: IsolateNamespaceRequest): Promise<{ created: number; skipped: number }> {
  const directions: ('ingress' | 'egress')[] = req.direction === 'both' ? ['ingress', 'egress'] : [req.direction]
  const ops: { action: 'write'; path: string; content: string }[] = []
  const summary: string[] = []

  for (const dir of directions) {
    const policyName = sanitizeK8sName(`floodgate-ns-deny-${dir}-${req.namespace}`)
    const spec: Record<string, unknown> = { podSelector: {}, policyTypes: [dir === 'ingress' ? 'Ingress' : 'Egress'] }
    if (dir === 'ingress') spec.ingress = []
    else spec.egress = []
    const doc = {
      apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
      metadata: {
        name: policyName, namespace: req.namespace,
        labels: {
          'managed-by': MANAGED_BY, 'floodgate-policy-type': `restrict-${dir}`,
          'source-workload': '', 'source-namespace': '', 'target-service': '', 'target-port': '0',
        },
      },
      spec,
    }
    ops.push({ action: 'write', path: policyFilePath(req.namespace, policyName), content: yaml.dump(doc, { lineWidth: -1 }) })
    summary.push(`deny-${dir}`)
  }

  if (req.allow_intra_namespace) {
    for (const dir of directions) {
      const policyName = sanitizeK8sName(`floodgate-intra-${dir}-${req.namespace}`)
      const spec: Record<string, unknown> = { podSelector: {}, policyTypes: [dir === 'ingress' ? 'Ingress' : 'Egress'] }
      if (dir === 'ingress') {
        spec.ingress = [{ from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': req.namespace } } }] }]
      } else {
        spec.egress = [
          { to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': req.namespace } } }] },
          { ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] },
        ]
      }
      const doc = {
        apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
        metadata: {
          name: policyName, namespace: req.namespace,
          labels: {
            'managed-by': MANAGED_BY, 'floodgate-policy-type': 'allow-intranamespace',
            'source-workload': '', 'source-namespace': req.namespace.slice(0, 63),
            'target-service': '', 'target-port': '0',
          },
        },
        spec,
      }
      ops.push({ action: 'write', path: policyFilePath(req.namespace, policyName), content: yaml.dump(doc, { lineWidth: -1 }) })
      summary.push(`intra-${dir}`)
    }
  }

  if (req.allow_egress_internet && (req.direction === 'egress' || req.direction === 'both')) {
    const policyName = sanitizeK8sName(`floodgate-egress-internet-${req.namespace}`)
    const doc = {
      apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
      metadata: {
        name: policyName, namespace: req.namespace,
        labels: {
          'managed-by': MANAGED_BY, 'floodgate-policy-type': 'allow-egress',
          'source-workload': '', 'source-namespace': req.namespace.slice(0, 63),
          'target-service': 'internet', 'target-port': '80',
        },
      },
      spec: {
        podSelector: {},
        policyTypes: ['Egress'],
        egress: [
          {
            to: [{ ipBlock: { cidr: '0.0.0.0/0', except: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10'] } }],
            ports: [{ protocol: 'TCP', port: 80 }, { protocol: 'TCP', port: 443 }],
          },
          { ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] },
        ],
      },
    }
    ops.push({ action: 'write', path: policyFilePath(req.namespace, policyName), content: yaml.dump(doc, { lineWidth: -1 }) })
    summary.push('egress-internet')
  }

  if (ops.length === 0) return { created: 0, skipped: 0 }
  await commitPolicyFilesTracked(ops, `floodgate: isolate ${req.namespace} (${summary.join(', ')})`)
  return { created: ops.length, skipped: 0 }
}

export async function createCidrPolicyViaGit(req: CidrPolicyRequest): Promise<NetworkPolicyInfo> {
  const { namespace, service_name, cidr, except, dst_ports, direction } = req
  const podSelector = service_name ? await resolvePodSelector(service_name, namespace) : {}

  const kPorts = (dst_ports?.length ?? 0) > 0
    ? dst_ports!.map(p => ({ protocol: p.protocol, port: p.port, ...(p.endPort !== undefined ? { endPort: p.endPort } : {}) }))
    : undefined

  const ipBlock = { cidr, ...(except?.length ? { except } : {}) }
  const policyType = `cidr-${direction}` as 'cidr-ingress' | 'cidr-egress'
  const safeCidr = cidr.replace(/\//g, '-').replace(/\./g, '-')
  const policyName = sanitizeK8sName(`floodgate-cidr-${direction}-${safeCidr}${service_name ? `-${service_name}` : ''}`)

  const doc = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: {
      name: policyName,
      namespace,
      labels: {
        'managed-by': MANAGED_BY,
        'floodgate-policy-type': policyType,
        'target-service': service_name ?? '',
        'target-port': String(dst_ports?.[0]?.port ?? 0),
        'source-workload': '',
        'source-namespace': '',
      },
    },
    spec: {
      podSelector: { matchLabels: podSelector },
      policyTypes: [direction === 'ingress' ? 'Ingress' : 'Egress'],
      ...(direction === 'ingress'
        ? { ingress: [{ from: [{ ipBlock }], ...(kPorts ? { ports: kPorts } : {}) }] }
        : { egress: [{ to: [{ ipBlock }], ...(kPorts ? { ports: kPorts } : {}) }] }),
    },
  }

  await commitPolicyFilesTracked(
    [{ action: 'write', path: policyFilePath(namespace, policyName), content: yaml.dump(doc, { lineWidth: -1 }) }],
    `floodgate: cidr-${direction} ${namespace} ${cidr}${service_name ? ` (${service_name})` : ''}`,
  )

  return {
    name: policyName, namespace, managed: true, policy_type: policyType,
    src_workload: '', src_namespace: '',
    dst_service: service_name ?? '', dst_port: 0,
    dst_ports: dst_ports ?? [], policy_types: [direction === 'ingress' ? 'Ingress' : 'Egress'],
    pod_selector: podSelector, ingress_count: 0, egress_count: 0,
    created_at: new Date().toISOString(),
    sync_status: 'pending_argocd',
  }
}

// getPolicyYAML's git-mode read. Direct mode reads a LIVE object (extra
// server-populated fields like resourceVersion/uid) and has to clean it
// via yamlSafeSpec() before dumping; a git-tracked file was built by one
// of the ViaGit functions above and never touched the K8s API, so it's
// already in exactly this clean shape: return it verbatim.
export async function getPolicyYAMLViaGit(namespace: string, name: string): Promise<string> {
  const content = await readPolicyFile(policyFilePath(namespace, name))
  if (content === null) throw new UserFacingError(`Policy ${namespace}/${name} não encontrada no repositório GitOps (ainda não commitada, ou o ArgoCD ainda não sincronizou)`, 404)
  return content
}

// import/resume both hand this an already-clean YAML doc (either exported
// by getPolicyYAML/getPolicyYAMLViaGit, or from a paused-policy snapshot;
// both already use real from/to field names, never the _from
// client-node quirk): write it through unchanged, no re-serialization.
export async function applyPolicyYAMLViaGit(namespace: string, yamlStr: string): Promise<void> {
  const parsed = yaml.load(yamlStr) as { metadata?: { name?: string } } | undefined
  const rawName = parsed?.metadata?.name
  if (!rawName) throw new UserFacingError('YAML de policy sem metadata.name', 400)
  // Unlike every other *ViaGit writer, this name comes straight from
  // imported/parsed YAML content (POST /api/networkpolicies/import), not
  // from a floodgate-built request: sanitize it the same way the others
  // build their own names, so a name containing "/" or "../" segments
  // can't make policyFilePath() write outside the intended
  // policies/<namespace>/ subtree once applyFileOps() joins and
  // normalizes the path.
  const name = sanitizeK8sName(rawName)
  await commitPolicyFilesTracked(
    [{ action: 'write', path: policyFilePath(namespace, name), content: yamlStr }],
    `floodgate: apply ${namespace}/${name}`,
  )
}

// adoptPolicy's write step only: the read/relabel happens in k8s.ts
// (shared with direct mode, since adopting an unmanaged object requires a
// live read either way: it isn't tracked in git yet, that's the whole
// point of adopting it). `policy` already has its labels updated by the
// caller; this only needs to persist it.
export async function adoptPolicyViaGit(policy: k8s.V1NetworkPolicy): Promise<string> {
  const namespace = policy.metadata!.namespace!
  const name = policy.metadata!.name!
  const clean = {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: { name, namespace, labels: policy.metadata?.labels },
    spec: yamlSafeSpec(policy.spec),
  }
  const content = yaml.dump(clean, { lineWidth: -1 })
  await commitPolicyFilesTracked([{ action: 'write', path: policyFilePath(namespace, name), content }], `floodgate: adopt ${namespace}/${name}`)
  return content
}

// unadoptPolicy never deletes the live object (same as direct mode): under
// GitOps that means rewriting the file without floodgate's labels, not
// removing it (removing it would prune the live object via ArgoCD, a real
// behavior change direct-mode unadopt never has). Reads from git, not
// live: by the time something can be unadopted it's already tracked here.
export async function unadoptPolicyViaGit(namespace: string, name: string): Promise<void> {
  const content = await readPolicyFile(policyFilePath(namespace, name))
  if (content === null) return
  const doc = yaml.load(content) as { metadata?: { labels?: Record<string, string> } }
  if (doc.metadata?.labels) {
    for (const key of [
      'managed-by', 'floodgate-policy-type', 'floodgate-adopted',
      'source-workload', 'source-namespace', 'target-service', 'target-port',
    ]) delete doc.metadata.labels[key]
  }
  await commitPolicyFilesTracked(
    [{ action: 'write', path: policyFilePath(namespace, name), content: yaml.dump(doc, { lineWidth: -1 }) }],
    `floodgate: unadopt ${namespace}/${name}`,
  )
}

// patchNetworkPolicyPort's read step: direct mode reads the live object's
// labels/spec to figure out what to recreate with new ports; under GitOps
// that has to come from the git file instead (the live object may not
// exist yet, or may be stale if ArgoCD hasn't synced the latest commit).
export async function patchNetworkPolicyPortViaGit(
  namespace: string, name: string, newPorts: PortSpec[],
): Promise<NetworkPolicyInfo> {
  const content = await readPolicyFile(policyFilePath(namespace, name))
  if (content === null) throw new UserFacingError(`Policy ${namespace}/${name} não encontrada no repositório GitOps`, 404)
  const existing = yaml.load(content) as {
    metadata?: { labels?: Record<string, string> }
    spec?: { egress?: Array<{ to?: Array<{ namespaceSelector?: { matchLabels?: Record<string, string> } }> }> }
  }
  const labels = existing.metadata?.labels ?? {}
  const policyType = labels['floodgate-policy-type'] ?? 'allow'

  if (policyType !== 'allow' && policyType !== 'allow-egress') {
    throw new UserFacingError(`Tipo de policy "${policyType}" não suporta edição de porta`)
  }

  let result: NetworkPolicyInfo
  if (policyType === 'allow') {
    result = await createNetworkPolicyViaGit({
      src_workload: labels['source-workload'] ?? '',
      src_namespace: labels['source-namespace'] ?? '',
      dst_service: labels['target-service'] ?? '',
      dst_namespace: namespace,
      dst_ports: newPorts,
    })
  } else {
    const dstNs = existing.spec?.egress?.[0]?.to?.[0]?.namespaceSelector?.matchLabels?.['kubernetes.io/metadata.name'] ?? ''
    result = await createEgressNetworkPolicyViaGit({
      src_workload: labels['source-workload'] ?? '',
      src_namespace: namespace,
      dst_service: labels['target-service'] ?? '',
      dst_namespace: dstNs,
      dst_ports: newPorts,
    })
  }

  if (result.name !== name) await deleteNetworkPolicyViaGit(namespace, name)
  return result
}

interface ParsedPolicyDoc {
  metadata?: { labels?: Record<string, string> }
  spec?: {
    podSelector?: { matchLabels?: Record<string, string> }
    policyTypes?: string[]
    ingress?: Array<{ ports?: Array<{ port?: number; protocol?: string; endPort?: number }> }>
    egress?: Array<{ to?: unknown[]; ports?: Array<{ port?: number; protocol?: string; endPort?: number }> }>
  }
}

// Mirrors listNetworkPolicies()'s managed-policy branch in k8s.ts (same
// label/spec fields, same port-extraction rule: port 53/DNS excluded)
// but sourced from a git-stored YAML doc instead of a live object.
// Deliberately a separate copy rather than a shared helper: the live
// version reads from a k8s.V1NetworkPolicy (client-node's typed shape),
// this one from yaml.load's untyped output: different enough inputs that
// forcing one function to handle both would need its own translation
// layer, which is more moving parts than just keeping the two in sync by
// eye (this file exists precisely to keep every git-mode code path
// independently reviewable against its direct-mode sibling).
function networkPolicyInfoFromGitDoc(namespace: string, name: string, doc: ParsedPolicyDoc): NetworkPolicyInfo {
  const labels = doc.metadata?.labels ?? {}
  const spec = doc.spec ?? {}
  const policyType = (labels['floodgate-policy-type'] ?? 'allow') as NetworkPolicyInfo['policy_type']
  const rawPorts = policyType === 'allow-egress' || policyType === 'cidr-egress'
    ? (spec.egress?.find(r => r.to && r.to.length > 0)?.ports ?? [])
    : (spec.ingress?.[0]?.ports ?? [])
  const specPorts: PortSpec[] = rawPorts
    .filter(pp => pp.port !== undefined && pp.port !== 53)
    .map(pp => ({
      port: Number(pp.port), protocol: (pp.protocol ?? 'TCP') as 'TCP' | 'UDP' | 'SCTP',
      ...(pp.endPort !== undefined ? { endPort: Number(pp.endPort) } : {}),
    }))
  const firstPort = parseInt(labels['target-port'] ?? '0') || 0
  const dst_ports = specPorts.length > 0 ? specPorts : (firstPort ? [{ port: firstPort, protocol: 'TCP' as const }] : [])

  return {
    name, namespace,
    src_workload: labels['source-workload'] ?? '',
    src_namespace: labels['source-namespace'] ?? '',
    dst_service: labels['target-service'] ?? '',
    dst_port: firstPort,
    dst_ports,
    policy_type: policyType,
    managed: true,
    adopted: labels['floodgate-adopted'] === 'true',
    policy_types: spec.policyTypes ?? [],
    pod_selector: spec.podSelector?.matchLabels ?? {},
    ingress_count: spec.ingress?.length ?? 0,
    egress_count: spec.egress?.length ?? 0,
    sync_status: 'pending_argocd',
  }
}

// GET /api/networkpolicies' GitOps-mode augmentation: `live` is exactly
// what listNetworkPolicies() already returns (unchanged); this only adds
// sync_status to each managed entry (applied = still tracked in git,
// pending_delete = live but the file's gone, waiting on ArgoCD's prune)
// and synthesizes an entry for anything git has that isn't live yet
// (pending_argocd), otherwise a policy someone just created would appear
// to vanish until the next ArgoCD sync instead of showing as pending.
export async function mergeGitSyncStatus(live: NetworkPolicyInfo[]): Promise<NetworkPolicyInfo[]> {
  // GitOps enabled but the repo connection hasn't been configured yet
  // (fresh deploy, admin hasn't filled in Config → GitOps): the dashboard
  // still needs to show live cluster state, so degrade to "no sync info"
  // instead of 503ing this every-15s-polled read and taking the whole
  // Policies view down with it. Write paths (create/delete/etc, all in
  // this same file) intentionally keep hard-failing via buildRealConfig(),
  // since there's no live data to fall back to for an actual write.
  if (!hasGitOpsCredentials()) return live
  let files: Array<{ path: string; content: string }>
  try {
    files = await listPolicyFilesWithContent()
  } catch (e) {
    // Configured, but the repo is unreachable right now (network blip, bad
    // SSH auth, DNS failure, the git host down, ...). page.tsx's very first
    // load fetches this in the same Promise.all as getServices(); letting
    // a git failure here reject that whole call meant services/policies
    // never rendered at all until the connection was removed again. Same
    // "must not take the dashboard down" reasoning as the not-configured
    // case above, just a different cause.
    console.error('[gitops] mergeGitSyncStatus: falha ao ler o repositório, mostrando estado ao vivo sem sync_status:', e)
    return live
  }
  const byPath = new Map(files.map(f => [f.path, f.content]))
  const liveKeys = new Set(live.filter(p => p.managed).map(p => `${p.namespace}/${p.name}`))

  // In-flight writes (commitPolicyFilesTracked's own bookkeeping): the
  // read lock was deliberately dropped (git.ts's withGitLock now guards
  // writes only), so a read can legitimately land WHILE a write's
  // commit+push is still running, seeing neither the live object nor the
  // git file yet. Without this, that window showed nothing at all for the
  // item being worked on.
  const pending = new Map(listPendingOps().map(p => [`${p.namespace}/${p.name}`, p.kind]))

  // Populated only when git.ts's own periodic background refresh has run
  // at least once (getLastKnownCommitAuthors, see its own comment). No
  // entry for a path means "no provenance info yet," treated as
  // not-external rather than guessed either way: avoids false positives
  // right after a restart before the first background refresh completes.
  const lastAuthors = getLastKnownCommitAuthors()
  const botAuthor = getGitOpsConfig().commit_author_name

  const result: NetworkPolicyInfo[] = live.map(p => {
    if (!p.managed) return p // external/unmanaged policies have no git counterpart at all
    const path = `${p.namespace}/${p.name}.yaml`
    const stillInGit = byPath.has(path)
    const pendingKind = pending.get(`${p.namespace}/${p.name}`)
    const lastAuthor = lastAuthors.get(path)
    return {
      ...p,
      sync_status: stillInGit ? 'applied' : 'pending_delete',
      ...(pendingKind ? { pending_write: pendingKind } : {}),
      ...(lastAuthor !== undefined && lastAuthor !== botAuthor ? { external_change: true } : {}),
    }
  })

  for (const [path, content] of byPath) {
    const match = path.match(/^(.+)\/([^/]+)\.yaml$/)
    if (!match) continue
    const [, namespace, name] = match
    if (liveKeys.has(`${namespace}/${name}`)) continue // handled above already
    const pendingKind = pending.get(`${namespace}/${name}`)
    const lastAuthor = lastAuthors.get(path)
    const externalChange = lastAuthor !== undefined && lastAuthor !== botAuthor
    try {
      const info = networkPolicyInfoFromGitDoc(namespace, name, yaml.load(content) as ParsedPolicyDoc)
      result.push({
        ...info,
        ...(pendingKind ? { pending_write: pendingKind } : {}),
        ...(externalChange ? { external_change: true } : {}),
      })
    } catch (e) {
      // A malformed file used to just be skipped (logged server-side, but
      // the entry silently vanished from the list with no trace anywhere a
      // user could see it). Surface it instead: every other field here is
      // a placeholder, since there's no valid spec/labels to read from.
      console.error(`[gitops] mergeGitSyncStatus: falha ao ler ${path} do repositório:`, e)
      result.push({
        name, namespace, src_workload: '', src_namespace: '', dst_service: '', dst_port: 0, dst_ports: [],
        policy_type: 'allow', managed: true, policy_types: [], pod_selector: {}, ingress_count: 0, egress_count: 0,
        invalid_file: true,
        ...(externalChange ? { external_change: true } : {}),
      })
    }
  }

  // A brand-new apply whose commit hasn't landed on disk yet (this read
  // raced ahead of it): neither live nor in byPath. Synthesize a minimal
  // placeholder just so the item shows up as "aplicando" immediately
  // instead of the row being empty for the few seconds the push takes.
  const shownKeys = new Set(result.map(p => `${p.namespace}/${p.name}`))
  for (const [key, kind] of pending) {
    if (kind !== 'apply' || shownKeys.has(key)) continue
    const [namespace, name] = key.split('/')
    result.push({
      name, namespace, src_workload: '', src_namespace: '', dst_service: '', dst_port: 0, dst_ports: [],
      policy_type: 'allow', managed: true, policy_types: [], pod_selector: {}, ingress_count: 0, egress_count: 0,
      pending_write: 'apply',
    })
  }

  return result
}
