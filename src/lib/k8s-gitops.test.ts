import { describe, it, expect, vi, beforeEach } from 'vitest'
import yaml from 'js-yaml'
import type { GitFileOp } from './git'
import type { NetworkPolicyInfo } from '@/types'

vi.mock('server-only', () => ({}))

// k8s-gitops.ts's job is to build the same NetworkPolicy content the
// direct-mode function would, and hand it to git.ts. git.ts's own
// clone/commit/push/rebase machinery is already proven against a real
// local bare repo in git.test.ts, so here it's mocked to a spy: this test
// is about the CONTENT and WIRING, not re-proving git plumbing.
const commitPolicyFiles = vi.fn(async (_ops: GitFileOp[], _message: string) => ({ commit: 'abc123' }))
const readPolicyFile = vi.fn(async (_path: string): Promise<string | null> => null)
const listPolicyFilesWithContent = vi.fn(async (): Promise<Array<{ path: string; content: string }>> => [])
const hasGitOpsCredentials = vi.fn(() => true)
const getLastKnownCommitAuthors = vi.fn((): Map<string, string> => new Map())
vi.mock('./git', () => ({ commitPolicyFiles, readPolicyFile, listPolicyFilesWithContent, hasGitOpsCredentials, getLastKnownCommitAuthors }))

const startPendingOp = vi.fn()
const finishPendingOp = vi.fn()
const listPendingOps = vi.fn((): Array<{ namespace: string; name: string; kind: 'apply' | 'delete'; started_at: string }> => [])
vi.mock('./gitopsPendingOps', () => ({ startPendingOp, finishPendingOp, listPendingOps }))

const getGitOpsConfig = vi.fn(() => ({
  repo_url: 'git@example.invalid:org/repo.git', repo_branch: 'main', repo_path: 'policies',
  commit_author_name: 'floodgate-bot', commit_author_email: 'floodgate@localhost',
  ssh_known_hosts_configured: false, credentials_configured: true,
}))
vi.mock('./gitopsConfig', () => ({ getGitOpsConfig }))

const resolvePodSelector = vi.fn(async () => ({ app: 'my-service' }))
const resolveWorkload = vi.fn(async () => ({ selector: { app: 'dst-service' }, service: null }))
const resolveTargetPortMaybeService = vi.fn(async (_svc: unknown, _ns: string, port: number) => port)
vi.mock('./k8s', () => ({
  resolvePodSelector,
  resolveWorkload,
  resolveTargetPortMaybeService,
  yamlSafeSpec: (spec: unknown) => spec,
  sanitizeK8sName: (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
  sanitizeLabelValue: (s: string) => s,
  MANAGED_BY: 'floodgate',
}))

const {
  createRestrictPolicyViaGit, deleteNetworkPolicyViaGit, createNetworkPolicyViaGit, createEgressNetworkPolicyViaGit,
  createNamespaceIngressPolicyViaGit, createNamespaceRestrictPolicyViaGit, isolateNamespaceViaGit, createCidrPolicyViaGit,
  getPolicyYAMLViaGit, applyPolicyYAMLViaGit, adoptPolicyViaGit, unadoptPolicyViaGit, patchNetworkPolicyPortViaGit,
  mergeGitSyncStatus, deleteNetworkPoliciesBatchViaGit,
} = await import('./k8s-gitops')

beforeEach(() => {
  commitPolicyFiles.mockClear()
  readPolicyFile.mockReset()
  readPolicyFile.mockResolvedValue(null)
  listPolicyFilesWithContent.mockReset()
  listPolicyFilesWithContent.mockResolvedValue([])
  hasGitOpsCredentials.mockClear().mockReturnValue(true)
  getLastKnownCommitAuthors.mockClear().mockReturnValue(new Map())
  getGitOpsConfig.mockClear()
  startPendingOp.mockClear()
  finishPendingOp.mockClear()
  listPendingOps.mockClear().mockReturnValue([])
  resolvePodSelector.mockClear()
  resolveWorkload.mockClear()
  resolveTargetPortMaybeService.mockClear()
})

function firstDoc<T = Record<string, unknown>>(): T {
  const [ops] = commitPolicyFiles.mock.calls[0]
  return yaml.load(ops[0].content!) as T
}

describe('createRestrictPolicyViaGit', () => {
  it('writes policies/<namespace>/<name>.yaml with the same spec createRestrictPolicy (direct mode) would build', async () => {
    const result = await createRestrictPolicyViaGit({ namespace: 'backend', service_name: 'worker', direction: 'ingress' })

    expect(commitPolicyFiles).toHaveBeenCalledTimes(1)
    const [ops, message] = commitPolicyFiles.mock.calls[0]
    expect(ops).toHaveLength(1)
    expect(ops[0].action).toBe('write')
    expect(ops[0].path).toBe('backend/floodgate-restrict-ingress-worker.yaml')
    expect(message).toMatch(/restrict-ingress backend\/worker/)

    const doc = firstDoc<{
      apiVersion: string; kind: string
      metadata: { name: string; namespace: string; labels: Record<string, string> }
      spec: { podSelector: { matchLabels: Record<string, string> }; policyTypes: string[]; ingress: unknown[] }
    }>()
    expect(doc.apiVersion).toBe('networking.k8s.io/v1')
    expect(doc.kind).toBe('NetworkPolicy')
    expect(doc.metadata.name).toBe('floodgate-restrict-ingress-worker')
    expect(doc.metadata.namespace).toBe('backend')
    expect(doc.metadata.labels['managed-by']).toBe('floodgate')
    expect(doc.metadata.labels['floodgate-policy-type']).toBe('restrict-ingress')
    expect(doc.metadata.labels['target-service']).toBe('worker')
    expect(doc.spec.podSelector.matchLabels).toEqual({ app: 'my-service' })
    expect(doc.spec.policyTypes).toEqual(['Ingress'])
    expect(doc.spec.ingress).toEqual([])

    expect(result.sync_status).toBe('pending_argocd')
    expect(result.name).toBe('floodgate-restrict-ingress-worker')
    expect(result.namespace).toBe('backend')
  })

  it('builds an egress restrict policy with an empty egress rule list, not ingress', async () => {
    await createRestrictPolicyViaGit({ namespace: 'backend', service_name: 'worker', direction: 'egress' })
    const doc = firstDoc<{ spec: { policyTypes: string[]; egress?: unknown[]; ingress?: unknown[] } }>()
    expect(doc.spec.policyTypes).toEqual(['Egress'])
    expect(doc.spec.egress).toEqual([])
    expect(doc.spec.ingress).toBeUndefined()
  })
})

describe('deleteNetworkPolicyViaGit', () => {
  it('removes the matching policy file via a single delete op', async () => {
    await deleteNetworkPolicyViaGit('backend', 'floodgate-restrict-ingress-worker')
    expect(commitPolicyFiles).toHaveBeenCalledTimes(1)
    const [ops, message] = commitPolicyFiles.mock.calls[0]
    expect(ops).toEqual([{ action: 'delete', path: 'backend/floodgate-restrict-ingress-worker.yaml' }])
    expect(message).toMatch(/delete backend\/floodgate-restrict-ingress-worker/)
  })
})

describe('deleteNetworkPoliciesBatchViaGit', () => {
  it('removes every policy in a SINGLE commit, not one per policy', async () => {
    listPolicyFilesWithContent.mockResolvedValue([
      { path: 'backend/floodgate-restrict-ingress-worker.yaml', content: '' },
      { path: 'cache/floodgate-ns-deny-egress-cache.yaml', content: '' },
    ])
    await deleteNetworkPoliciesBatchViaGit([
      { namespace: 'backend', name: 'floodgate-restrict-ingress-worker' },
      { namespace: 'cache', name: 'floodgate-ns-deny-egress-cache' },
    ])
    expect(commitPolicyFiles).toHaveBeenCalledTimes(1)
    const [ops, message] = commitPolicyFiles.mock.calls[0]
    expect(ops).toEqual([
      { action: 'delete', path: 'backend/floodgate-restrict-ingress-worker.yaml' },
      { action: 'delete', path: 'cache/floodgate-ns-deny-egress-cache.yaml' },
    ])
    expect(message).toMatch(/delete 2 policies/)
  })

  it('is a no-op when given an empty list: no commit attempted', async () => {
    await deleteNetworkPoliciesBatchViaGit([])
    expect(commitPolicyFiles).not.toHaveBeenCalled()
  })

  // applyFileOps (git.ts) silently skips a delete op whose file is already
  // gone; used to mean deleteNetworkPoliciesBatch (k8s.ts) reported the
  // whole batch as "succeeded" even for entries nothing was actually done
  // for. Excluding the missing ones from the commit up front (checked via
  // listPolicyFilesWithContent) keeps the commit message/op count honest
  // about what this call actually touched.
  it('excludes a policy whose file is already missing from the repo: no op for it, no false "removed" claim', async () => {
    listPolicyFilesWithContent.mockResolvedValue([
      { path: 'backend/still-there.yaml', content: '' },
      // 'backend/already-gone.yaml' is NOT in the repo listing
    ])
    await deleteNetworkPoliciesBatchViaGit([
      { namespace: 'backend', name: 'still-there' },
      { namespace: 'backend', name: 'already-gone' },
    ])
    expect(commitPolicyFiles).toHaveBeenCalledTimes(1)
    const [ops, message] = commitPolicyFiles.mock.calls[0]
    expect(ops).toEqual([{ action: 'delete', path: 'backend/still-there.yaml' }])
    expect(message).toMatch(/delete 1 polic/)
  })

  it('is a no-op (no commit at all) when every policy in the batch is already missing from the repo', async () => {
    listPolicyFilesWithContent.mockResolvedValue([]) // nothing in the repo
    await deleteNetworkPoliciesBatchViaGit([{ namespace: 'backend', name: 'already-gone' }])
    expect(commitPolicyFiles).not.toHaveBeenCalled()
  })

  // commitPolicyFilesTracked (the wrapper every write goes through) marks
  // EVERY touched policy as pending before the one commit, and clears all
  // of them together once it settles; proven here so the aggregate
  // "removendo N políticas" banner (RightPanel.tsx) has real data behind it.
  it('marks every policy as a pending delete for the duration of the one commit', async () => {
    listPolicyFilesWithContent.mockResolvedValue([
      { path: 'backend/a.yaml', content: '' },
      { path: 'backend/b.yaml', content: '' },
    ])
    let pendingDuringCommit: unknown[] = []
    commitPolicyFiles.mockImplementation(async () => {
      pendingDuringCommit = startPendingOp.mock.calls.map(c => c)
      return { commit: 'abc123' }
    })
    await deleteNetworkPoliciesBatchViaGit([
      { namespace: 'backend', name: 'a' },
      { namespace: 'backend', name: 'b' },
    ])
    expect(pendingDuringCommit).toEqual([
      ['backend', 'a', 'delete'],
      ['backend', 'b', 'delete'],
    ])
    expect(finishPendingOp).toHaveBeenCalledWith('backend', 'a')
    expect(finishPendingOp).toHaveBeenCalledWith('backend', 'b')
  })
})

describe('createNetworkPolicyViaGit', () => {
  it('builds an allow-ingress policy with a real "from" field (not the client-node _from quirk)', async () => {
    const result = await createNetworkPolicyViaGit({
      src_workload: 'web', src_namespace: 'frontend', dst_service: 'api', dst_namespace: 'backend',
      dst_ports: [{ port: 8080, protocol: 'TCP' }],
    })
    const [ops, message] = commitPolicyFiles.mock.calls[0]
    expect(ops[0].path).toBe('backend/floodgate-allow-web-frontend-to-api.yaml')
    expect(message).toMatch(/frontend\/web -> backend\/api/)

    const doc = firstDoc<{ spec: { ingress: Array<{ from: unknown[]; ports: Array<{ port: number }> }> } }>()
    expect(doc.spec.ingress[0].from).toBeDefined()
    expect((doc as unknown as Record<string, unknown>).spec).not.toHaveProperty('_from')
    expect(doc.spec.ingress[0].ports[0].port).toBe(8080)
    expect(result.dst_port).toBe(8080)
    expect(result.sync_status).toBe('pending_argocd')
  })

  it('skips port resolution for a ranged port (endPort) and passes it through as-is', async () => {
    await createNetworkPolicyViaGit({
      src_workload: 'web', src_namespace: 'frontend', dst_service: 'api', dst_namespace: 'backend',
      dst_ports: [{ port: 9000, endPort: 9010, protocol: 'TCP' }],
    })
    expect(resolveTargetPortMaybeService).not.toHaveBeenCalled()
    const doc = firstDoc<{ spec: { ingress: Array<{ ports: Array<{ port: number; endPort: number }> }> } }>()
    expect(doc.spec.ingress[0].ports[0]).toEqual({ port: 9000, endPort: 9010, protocol: 'TCP' })
  })
})

describe('createEgressNetworkPolicyViaGit', () => {
  it('builds an allow-egress policy in the SOURCE namespace, with a DNS-allow rule appended', async () => {
    await createEgressNetworkPolicyViaGit({
      src_workload: 'web', src_namespace: 'frontend', dst_service: 'api', dst_namespace: 'backend',
      dst_ports: [{ port: 8080, protocol: 'TCP' }],
    })
    const [ops] = commitPolicyFiles.mock.calls[0]
    expect(ops[0].path).toBe('frontend/floodgate-egress-web-to-api.yaml')

    const doc = firstDoc<{ metadata: { namespace: string }; spec: { egress: Array<{ to?: unknown[]; ports: Array<{ port?: number; protocol: string }> }> } }>()
    expect(doc.metadata.namespace).toBe('frontend')
    expect(doc.spec.egress).toHaveLength(2)
    expect(doc.spec.egress[1]).toEqual({ ports: [{ protocol: 'UDP', port: 53 }, { protocol: 'TCP', port: 53 }] })
  })
})

describe('createNamespaceIngressPolicyViaGit', () => {
  it('allows an entire namespace in, on a single resolved pod port', async () => {
    await createNamespaceIngressPolicyViaGit({ src_namespace: 'frontend', dst_service: 'api', dst_namespace: 'backend', dst_port: 80 })
    const [ops] = commitPolicyFiles.mock.calls[0]
    expect(ops[0].path).toBe('backend/floodgate-allow-ns-frontend-to-api.yaml')
    const doc = firstDoc<{ metadata: { labels: Record<string, string> }; spec: { ingress: Array<{ from: Array<{ namespaceSelector: { matchLabels: Record<string, string> } }> }> } }>()
    expect(doc.metadata.labels['floodgate-policy-type']).toBe('allow-namespace')
    expect(doc.spec.ingress[0].from[0].namespaceSelector.matchLabels).toEqual({ 'kubernetes.io/metadata.name': 'frontend' })
  })
})

describe('createNamespaceRestrictPolicyViaGit', () => {
  it('returns created:true (git writes have no 409/skip concept)', async () => {
    const result = await createNamespaceRestrictPolicyViaGit('backend', 'egress')
    expect(result).toEqual({ name: 'floodgate-ns-deny-egress-backend', namespace: 'backend', created: true })
    const doc = firstDoc<{ spec: { policyTypes: string[]; egress: unknown[] } }>()
    expect(doc.spec.policyTypes).toEqual(['Egress'])
    expect(doc.spec.egress).toEqual([])
  })
})

describe('isolateNamespaceViaGit', () => {
  it('bundles deny + intra + internet-egress into a SINGLE commit, not three', async () => {
    const result = await isolateNamespaceViaGit({
      namespace: 'payments', direction: 'both', allow_intra_namespace: true, allow_egress_internet: true,
    })
    // 'both' directions: 2 deny + 2 intra + 1 internet-egress (egress only) = 5 files
    expect(commitPolicyFiles).toHaveBeenCalledTimes(1)
    const [ops] = commitPolicyFiles.mock.calls[0]
    expect(ops).toHaveLength(5)
    expect(result).toEqual({ created: 5, skipped: 0 })

    const paths = ops.map(o => o.path)
    expect(paths).toContain('payments/floodgate-ns-deny-ingress-payments.yaml')
    expect(paths).toContain('payments/floodgate-ns-deny-egress-payments.yaml')
    expect(paths).toContain('payments/floodgate-intra-ingress-payments.yaml')
    expect(paths).toContain('payments/floodgate-intra-egress-payments.yaml')
    expect(paths).toContain('payments/floodgate-egress-internet-payments.yaml')
  })

  it('internet-egress-allow only applies when direction includes egress', async () => {
    await isolateNamespaceViaGit({ namespace: 'payments', direction: 'ingress', allow_intra_namespace: false, allow_egress_internet: true })
    const [ops] = commitPolicyFiles.mock.calls[0]
    expect(ops.map(o => o.path)).not.toContain('payments/floodgate-egress-internet-payments.yaml')
  })

  it('with both companion flags off, writes only the deny policy for the given direction', async () => {
    const result = await isolateNamespaceViaGit({ namespace: 'payments', direction: 'ingress', allow_intra_namespace: false, allow_egress_internet: false })
    expect(commitPolicyFiles).toHaveBeenCalledTimes(1)
    const [ops] = commitPolicyFiles.mock.calls[0]
    expect(ops).toEqual([{ action: 'write', path: 'payments/floodgate-ns-deny-ingress-payments.yaml', content: expect.any(String) }])
    expect(result.created).toBe(1)
  })
})

describe('createCidrPolicyViaGit', () => {
  it('builds a cidr-egress policy with the real ipBlock/except shape', async () => {
    const result = await createCidrPolicyViaGit({
      namespace: 'backend', service_name: 'worker', cidr: '1.1.1.1/32', direction: 'egress', dst_ports: [{ port: 443, protocol: 'TCP' }],
    })
    const [ops] = commitPolicyFiles.mock.calls[0]
    expect(ops[0].path).toBe('backend/floodgate-cidr-egress-1-1-1-1-32-worker.yaml')
    const doc = firstDoc<{ spec: { egress: Array<{ to: Array<{ ipBlock: { cidr: string } }> }> } }>()
    expect(doc.spec.egress[0].to[0].ipBlock.cidr).toBe('1.1.1.1/32')
    expect(result.sync_status).toBe('pending_argocd')
  })
})

describe('getPolicyYAMLViaGit', () => {
  it('returns the git file content verbatim when it exists', async () => {
    readPolicyFile.mockResolvedValue('apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\n')
    const yamlStr = await getPolicyYAMLViaGit('backend', 'floodgate-restrict-ingress-worker')
    expect(yamlStr).toBe('apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\n')
    expect(readPolicyFile).toHaveBeenCalledWith('backend/floodgate-restrict-ingress-worker.yaml')
  })

  it('throws a clear 404-style error when the file is not tracked yet', async () => {
    readPolicyFile.mockResolvedValue(null)
    await expect(getPolicyYAMLViaGit('backend', 'nope')).rejects.toThrow(/não encontrada/)
  })
})

describe('applyPolicyYAMLViaGit', () => {
  it('writes the given YAML string through unchanged, keyed by its own metadata.name', async () => {
    const yamlStr = 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: floodgate-allow-x\n'
    await applyPolicyYAMLViaGit('backend', yamlStr)
    const [ops] = commitPolicyFiles.mock.calls[0]
    expect(ops).toEqual([{ action: 'write', path: 'backend/floodgate-allow-x.yaml', content: yamlStr }])
  })

  it('rejects YAML with no metadata.name', async () => {
    await expect(applyPolicyYAMLViaGit('backend', 'apiVersion: networking.k8s.io/v1\n')).rejects.toThrow(/metadata.name/)
    expect(commitPolicyFiles).not.toHaveBeenCalled()
  })

  // metadata.name here comes straight from imported/parsed YAML content
  // (POST /api/networkpolicies/import), unlike every other *ViaGit writer
  // whose name it builds itself: a path-traversal segment in an
  // untrusted name must never reach policyFilePath() unsanitized.
  it('sanitizes a metadata.name containing path-traversal segments before building the file path', async () => {
    const yamlStr = 'apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: "../../../etc/gitops_key"\n'
    await applyPolicyYAMLViaGit('backend', yamlStr)
    const [ops] = commitPolicyFiles.mock.calls[0]
    const [{ path }] = ops
    expect(path.startsWith('backend/')).toBe(true)
    expect(path).not.toContain('..')
    expect(path).not.toContain('/etc/')
  })
})

describe('adoptPolicyViaGit', () => {
  it('writes the already-relabeled live policy object to git, cleaning the _from client-node quirk', async () => {
    const livePolicy = {
      metadata: { name: 'legacy-policy', namespace: 'backend', labels: { 'managed-by': 'floodgate' } },
      spec: { podSelector: {}, policyTypes: ['Ingress'] },
    }
    const content = await adoptPolicyViaGit(livePolicy as never)
    const [ops] = commitPolicyFiles.mock.calls[0]
    expect(ops[0].path).toBe('backend/legacy-policy.yaml')
    expect(ops[0].content).toBe(content)
    const doc = yaml.load(content) as { metadata: { name: string; labels: Record<string, string> } }
    expect(doc.metadata.name).toBe('legacy-policy')
    expect(doc.metadata.labels['managed-by']).toBe('floodgate')
  })
})

describe('unadoptPolicyViaGit', () => {
  it('strips floodgate labels but keeps the file (never deletes)', async () => {
    readPolicyFile.mockResolvedValue(yaml.dump({
      apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy',
      metadata: {
        name: 'floodgate-restrict-ingress-worker', namespace: 'backend',
        labels: { 'managed-by': 'floodgate', 'floodgate-policy-type': 'restrict-ingress', 'target-service': 'worker', extra: 'keep-me' },
      },
      spec: { podSelector: {}, policyTypes: ['Ingress'], ingress: [] },
    }))
    await unadoptPolicyViaGit('backend', 'floodgate-restrict-ingress-worker')
    const [ops] = commitPolicyFiles.mock.calls[0]
    expect(ops[0].action).toBe('write') // not delete
    const doc = yaml.load(ops[0].content!) as { metadata: { labels: Record<string, string> } }
    expect(doc.metadata.labels['managed-by']).toBeUndefined()
    expect(doc.metadata.labels['floodgate-policy-type']).toBeUndefined()
    expect(doc.metadata.labels.extra).toBe('keep-me') // untouched, non-floodgate label
  })

  it('is a no-op when the file was never tracked in git', async () => {
    readPolicyFile.mockResolvedValue(null)
    await unadoptPolicyViaGit('backend', 'unknown-policy')
    expect(commitPolicyFiles).not.toHaveBeenCalled()
  })
})

describe('patchNetworkPolicyPortViaGit', () => {
  it('rebuilds an "allow" policy from its git file, sourcing labels instead of a live read', async () => {
    readPolicyFile.mockResolvedValue(yaml.dump({
      metadata: { labels: { 'floodgate-policy-type': 'allow', 'source-workload': 'web', 'source-namespace': 'frontend', 'target-service': 'api' } },
    }))
    const result = await patchNetworkPolicyPortViaGit('backend', 'floodgate-allow-web-frontend-to-api', [{ port: 9090, protocol: 'TCP' }])
    expect(result.dst_port).toBe(9090)
    expect(result.name).toBe('floodgate-allow-web-frontend-to-api') // same name → no delete of the old file
    // Only the recreate commit, no separate delete op, since the name didn't change.
    expect(commitPolicyFiles).toHaveBeenCalledTimes(1)
  })

  it('deletes the old file when patching changes the resolved policy name (e.g. an adopted policy)', async () => {
    readPolicyFile.mockResolvedValue(yaml.dump({
      metadata: { labels: { 'floodgate-policy-type': 'allow', 'source-workload': 'web', 'source-namespace': 'frontend', 'target-service': 'api' } },
    }))
    await patchNetworkPolicyPortViaGit('backend', 'some-legacy-adopted-name', [{ port: 9090, protocol: 'TCP' }])
    // First call: recreate under the canonical name. Second: delete the old (different) name.
    expect(commitPolicyFiles).toHaveBeenCalledTimes(2)
    const [deleteOps] = commitPolicyFiles.mock.calls[1]
    expect(deleteOps).toEqual([{ action: 'delete', path: 'backend/some-legacy-adopted-name.yaml' }])
  })

  it('rejects a policy type that does not support port editing', async () => {
    readPolicyFile.mockResolvedValue(yaml.dump({ metadata: { labels: { 'floodgate-policy-type': 'restrict-ingress' } } }))
    await expect(patchNetworkPolicyPortViaGit('backend', 'floodgate-restrict-ingress-worker', [{ port: 1, protocol: 'TCP' }]))
      .rejects.toThrow(/não suporta edição de porta/)
  })
})

function livePolicy(overrides: Partial<NetworkPolicyInfo> = {}): NetworkPolicyInfo {
  return {
    name: 'floodgate-restrict-ingress-worker', namespace: 'backend',
    src_workload: '', src_namespace: '', dst_service: 'worker', dst_port: 0, dst_ports: [],
    policy_type: 'restrict-ingress', managed: true, policy_types: ['Ingress'],
    pod_selector: {}, ingress_count: 0, egress_count: 0,
    ...overrides,
  }
}

describe('mergeGitSyncStatus', () => {
  it('marks a managed policy "applied" when its file is still tracked in git', async () => {
    listPolicyFilesWithContent.mockResolvedValue([{ path: 'backend/floodgate-restrict-ingress-worker.yaml', content: 'metadata: {}\nspec: {}\n' }])
    const result = await mergeGitSyncStatus([livePolicy()])
    expect(result).toHaveLength(1)
    expect(result[0].sync_status).toBe('applied')
  })

  it('marks a managed policy "pending_delete" when it is live but its file is gone from git', async () => {
    listPolicyFilesWithContent.mockResolvedValue([]) // nothing in the repo
    const result = await mergeGitSyncStatus([livePolicy()])
    expect(result[0].sync_status).toBe('pending_delete')
  })

  it('leaves unmanaged/external policies untouched: no git counterpart exists for them', async () => {
    const external = livePolicy({ policy_type: 'external', managed: false })
    const result = await mergeGitSyncStatus([external])
    expect(result[0].sync_status).toBeUndefined()
  })

  it('synthesizes a "pending_argocd" entry for a file that exists in git but has no live counterpart yet', async () => {
    listPolicyFilesWithContent.mockResolvedValue([{
      path: 'cache/floodgate-restrict-egress-redis.yaml',
      content: yaml.dump({
        metadata: { labels: { 'floodgate-policy-type': 'restrict-egress', 'target-service': 'redis' } },
        spec: { podSelector: { matchLabels: { app: 'redis' } }, policyTypes: ['Egress'], egress: [] },
      }),
    }])
    const result = await mergeGitSyncStatus([]) // nothing live yet
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      namespace: 'cache', name: 'floodgate-restrict-egress-redis',
      policy_type: 'restrict-egress', dst_service: 'redis', sync_status: 'pending_argocd',
    })
  })

  it('does not double-count a policy that is both live and in git (no synthesized duplicate)', async () => {
    listPolicyFilesWithContent.mockResolvedValue([{ path: 'backend/floodgate-restrict-ingress-worker.yaml', content: 'metadata: {}\nspec: {}\n' }])
    const result = await mergeGitSyncStatus([livePolicy()])
    expect(result).toHaveLength(1)
  })

  // GitOps enabled but the repo connection hasn't been configured in the
  // panel yet: GET /api/networkpolicies is polled every 15s, so this must
  // fall back to live data untouched instead of throwing (buildRealConfig's
  // 503, surfaced via listPolicyFilesWithContent) and taking the whole
  // Policies view down before an admin has had a chance to configure it.
  it('returns live policies untouched, without reading git, when the connection is not configured yet', async () => {
    hasGitOpsCredentials.mockReturnValue(false)
    const result = await mergeGitSyncStatus([livePolicy()])
    expect(result).toEqual([livePolicy()])
    expect(listPolicyFilesWithContent).not.toHaveBeenCalled()
  })

  // Configured (credentials present) but the repo itself is unreachable:
  // bad SSH auth, DNS failure, network blip. This used to reject straight
  // through to page.tsx's initial Promise.all (which fetches this in the
  // same batch as getServices()), so services/policies never rendered at
  // all until the connection was removed again. A real production report,
  // not just the not-configured case above.
  it('returns live policies untouched when the repo is configured but unreachable (network/auth failure)', async () => {
    listPolicyFilesWithContent.mockRejectedValue(new Error('ssh: Could not resolve hostname'))
    const result = await mergeGitSyncStatus([livePolicy()])
    expect(result).toEqual([livePolicy()])
  })

  // gitops_pending_ops (persisted, via listPendingOps; see
  // commitPolicyFilesTracked below) marks an item mid-write, independent of
  // sync_status: a delete in flight is still live (not pruned yet), just
  // with its own commit/push not settled.
  it('marks pending_write on a live policy with a matching in-flight delete', async () => {
    listPolicyFilesWithContent.mockResolvedValue([{ path: 'backend/floodgate-restrict-ingress-worker.yaml', content: 'metadata: {}\nspec: {}\n' }])
    listPendingOps.mockReturnValue([{ namespace: 'backend', name: 'floodgate-restrict-ingress-worker', kind: 'delete', started_at: 'now' }])
    const result = await mergeGitSyncStatus([livePolicy()])
    expect(result).toHaveLength(1)
    expect(result[0].pending_write).toBe('delete')
  })

  // A read racing a commit that hasn't landed on disk yet (git.ts's read
  // lock was deliberately dropped, so this window is real), neither live
  // nor in the repo files. Without this, that item was just absent from
  // the list for the few seconds the push takes.
  it('synthesizes a placeholder entry with pending_write "apply" for a commit not yet on disk', async () => {
    listPendingOps.mockReturnValue([{ namespace: 'backend', name: 'floodgate-allow-new-thing', kind: 'apply', started_at: 'now' }])
    const result = await mergeGitSyncStatus([])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ namespace: 'backend', name: 'floodgate-allow-new-thing', pending_write: 'apply' })
  })

  it('does not synthesize a placeholder once the policy is already shown as live or pending_argocd', async () => {
    listPolicyFilesWithContent.mockResolvedValue([{ path: 'backend/floodgate-restrict-ingress-worker.yaml', content: 'metadata: {}\nspec: {}\n' }])
    listPendingOps.mockReturnValue([{ namespace: 'backend', name: 'floodgate-restrict-ingress-worker', kind: 'apply', started_at: 'now' }])
    const result = await mergeGitSyncStatus([livePolicy()])
    expect(result).toHaveLength(1) // no duplicate placeholder alongside the real entry
  })

  // external_change: the last commit author for a managed policy's file,
  // compared against the configured floodgate bot identity; populated
  // only by git.ts's own periodic background refresh (getLastKnownCommitAuthors),
  // never computed inline here.
  describe('external_change detection', () => {
    it('flags a managed policy whose file was last committed by someone other than the floodgate bot', async () => {
      listPolicyFilesWithContent.mockResolvedValue([{ path: 'backend/floodgate-restrict-ingress-worker.yaml', content: 'metadata: {}\nspec: {}\n' }])
      getLastKnownCommitAuthors.mockReturnValue(new Map([['backend/floodgate-restrict-ingress-worker.yaml', 'someone-else']]))
      const result = await mergeGitSyncStatus([livePolicy()])
      expect(result[0].external_change).toBe(true)
    })

    it('does not flag a policy whose file was last committed by the configured bot identity', async () => {
      listPolicyFilesWithContent.mockResolvedValue([{ path: 'backend/floodgate-restrict-ingress-worker.yaml', content: 'metadata: {}\nspec: {}\n' }])
      getLastKnownCommitAuthors.mockReturnValue(new Map([['backend/floodgate-restrict-ingress-worker.yaml', 'floodgate-bot']]))
      const result = await mergeGitSyncStatus([livePolicy()])
      expect(result[0].external_change).toBeUndefined()
    })

    it('does not flag a policy with no provenance data yet (e.g. before the first background refresh completes)', async () => {
      listPolicyFilesWithContent.mockResolvedValue([{ path: 'backend/floodgate-restrict-ingress-worker.yaml', content: 'metadata: {}\nspec: {}\n' }])
      getLastKnownCommitAuthors.mockReturnValue(new Map()) // empty: no entry for this path
      const result = await mergeGitSyncStatus([livePolicy()])
      expect(result[0].external_change).toBeUndefined()
    })

    it('also flags a synthesized (git-only, not-yet-live) entry', async () => {
      getLastKnownCommitAuthors.mockReturnValue(new Map([['cache/floodgate-restrict-egress-redis.yaml', 'someone-else']]))
      listPolicyFilesWithContent.mockResolvedValue([{
        path: 'cache/floodgate-restrict-egress-redis.yaml',
        content: yaml.dump({
          metadata: { labels: { 'floodgate-policy-type': 'restrict-egress', 'target-service': 'redis' } },
          spec: { podSelector: { matchLabels: { app: 'redis' } }, policyTypes: ['Egress'], egress: [] },
        }),
      }])
      const result = await mergeGitSyncStatus([])
      expect(result[0].external_change).toBe(true)
    })
  })

  // invalid_file: a malformed YAML used to just be skipped (server-side log
  // only), now surfaced as a placeholder entry instead of the policy
  // silently vanishing from the list with no trace anywhere a user could see.
  it('surfaces a malformed git file as a placeholder entry with invalid_file, instead of silently skipping it', async () => {
    listPolicyFilesWithContent.mockResolvedValue([{ path: 'backend/floodgate-broken.yaml', content: 'not: valid: yaml: [' }])
    const result = await mergeGitSyncStatus([])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ namespace: 'backend', name: 'floodgate-broken', invalid_file: true })
  })
})

describe('commitPolicyFilesTracked (via any *ViaGit write)', () => {
  it('records the touched policy as pending before the commit, and clears it after success', async () => {
    let pendingDuringCommit: unknown
    commitPolicyFiles.mockImplementation(async () => {
      pendingDuringCommit = startPendingOp.mock.calls.length
      return { commit: 'abc123' }
    })
    await createRestrictPolicyViaGit({ service_name: 'worker', namespace: 'backend', direction: 'ingress' })
    expect(pendingDuringCommit).toBe(1) // startPendingOp had already run before commitPolicyFiles was called
    expect(startPendingOp).toHaveBeenCalledWith('backend', 'floodgate-restrict-ingress-worker', 'apply')
    expect(finishPendingOp).toHaveBeenCalledWith('backend', 'floodgate-restrict-ingress-worker')
  })

  it('still clears the pending entry when the commit itself fails', async () => {
    commitPolicyFiles.mockRejectedValue(new Error('push rejected'))
    await expect(deleteNetworkPolicyViaGit('backend', 'floodgate-restrict-ingress-worker')).rejects.toThrow('push rejected')
    expect(startPendingOp).toHaveBeenCalledWith('backend', 'floodgate-restrict-ingress-worker', 'delete')
    expect(finishPendingOp).toHaveBeenCalledWith('backend', 'floodgate-restrict-ingress-worker')
  })
})
