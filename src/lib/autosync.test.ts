import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

// Only the `paused` check (SELECT COUNT(*) FROM saved_policies) is ever hit
// by the gitops-mode paths under test here; checkDriftViaGit doesn't touch
// managed_policies at all (that's the whole point: git is the source of
// truth in this mode, not that table). A single always-zero mock covers it.
const dbGet = vi.fn(() => ({ n: 0 }))
vi.mock('./db', () => ({
  getDb: () => ({
    prepare: () => ({ get: dbGet, all: () => [] }),
  }),
}))

const listNetworkPolicies = vi.fn(async () => [] as Array<{ namespace: string; name: string }>)
const listNamespaceNames = vi.fn(async () => new Set<string>())
const applyPolicyYAML = vi.fn(async () => {})
const getPolicyYAML = vi.fn(async () => '')
vi.mock('./k8s', () => ({
  listNetworkPolicies, listNamespaceNames, applyPolicyYAML, getPolicyYAML,
  sanitizeK8sName: (s: string) => s,
}))

const listPolicyFiles = vi.fn(async () => [] as string[])
const hasGitOpsCredentials = vi.fn(() => true)
vi.mock('./git', () => ({ listPolicyFiles, hasGitOpsCredentials }))

let writeMode: 'direct' | 'gitops' = 'direct'
vi.mock('./writeMode', () => ({ getWriteMode: () => writeMode }))

const { checkDrift, runAutosync } = await import('./autosync')

beforeEach(() => {
  writeMode = 'direct'
  dbGet.mockReturnValue({ n: 0 })
  listNetworkPolicies.mockClear().mockResolvedValue([])
  listNamespaceNames.mockClear().mockResolvedValue(new Set())
  applyPolicyYAML.mockClear()
  getPolicyYAML.mockClear()
  listPolicyFiles.mockClear().mockResolvedValue([])
  hasGitOpsCredentials.mockClear().mockReturnValue(true)
})

describe('checkDrift: gitops mode', () => {
  it('compares repo files vs live K8s instead of managed_policies, "missing" meaning pending ArgoCD sync', async () => {
    writeMode = 'gitops'
    listPolicyFiles.mockResolvedValue(['backend/floodgate-restrict-ingress-worker.yaml', 'cache/floodgate-ns-deny-egress-cache.yaml'])
    listNetworkPolicies.mockResolvedValue([{ namespace: 'backend', name: 'floodgate-restrict-ingress-worker' }])
    listNamespaceNames.mockResolvedValue(new Set(['backend', 'cache']))

    const result = await checkDrift()
    expect(result.missing).toEqual([{ namespace: 'cache', name: 'floodgate-ns-deny-egress-cache', namespace_missing: false }])
  })

  it('flags namespace_missing when the git-tracked namespace no longer exists in the cluster', async () => {
    writeMode = 'gitops'
    listPolicyFiles.mockResolvedValue(['deleted-ns/floodgate-restrict-ingress-x.yaml'])
    listNetworkPolicies.mockResolvedValue([])
    listNamespaceNames.mockResolvedValue(new Set(['backend'])) // 'deleted-ns' not present

    const result = await checkDrift()
    expect(result.missing).toEqual([{ namespace: 'deleted-ns', name: 'floodgate-restrict-ingress-x', namespace_missing: true }])
  })

  it('direct mode never calls listPolicyFiles', async () => {
    writeMode = 'direct'
    await checkDrift()
    expect(listPolicyFiles).not.toHaveBeenCalled()
  })

  // GitOps enabled but the repo connection hasn't been configured in the
  // panel yet: GET /api/autosync is polled every 15s by the main dashboard,
  // so this must read as "nothing to report" rather than 503ing the poll;
  // previously buildRealConfig() (via listPolicyFiles) threw straight
  // through checkDriftViaGit here.
  it('reports empty drift, without touching the repo, when GitOps is enabled but not yet configured', async () => {
    writeMode = 'gitops'
    hasGitOpsCredentials.mockReturnValue(false)

    const result = await checkDrift()
    expect(result.missing).toEqual([])
    expect(listPolicyFiles).not.toHaveBeenCalled()
  })

  // Configured (credentials present) but the repo itself is unreachable:
  // bad SSH auth, DNS failure, network blip. This used to reject the whole
  // Promise.all below even though listNetworkPolicies/listNamespaceNames
  // don't touch git. A real production report: after configuring a real
  // (but unreachable) connection, the main dashboard's initial load broke
  // entirely instead of just this one drift signal going stale.
  it('reports empty drift, not an error, when the repo is configured but unreachable', async () => {
    writeMode = 'gitops'
    listPolicyFiles.mockRejectedValue(new Error('ssh: Could not resolve hostname'))

    const result = await checkDrift()
    expect(result.missing).toEqual([])
  })
})

describe('runAutosync: gitops mode', () => {
  it('never calls applyPolicyYAML (the reapply half stays off), but still runs drift detection', async () => {
    writeMode = 'gitops'
    listPolicyFiles.mockResolvedValue(['backend/floodgate-restrict-ingress-worker.yaml'])
    listNetworkPolicies.mockResolvedValue([])

    const result = await runAutosync()
    expect(applyPolicyYAML).not.toHaveBeenCalled()
    expect(result.fixed).toBe(0)
    expect(result.checked).toBe(0)
  })

  it('direct mode never reaches the gitops early-return (no drift, nothing to fix, but applyPolicyYAML stays reachable)', async () => {
    writeMode = 'direct'
    const result = await runAutosync()
    // With every DB query mocked empty, direct mode's own seed/restore
    // logic naturally finds nothing to do; the point here is just that no
    // gitops-only short-circuit fired to prevent it from trying.
    expect(result).toEqual(expect.objectContaining({ checked: 0, fixed: 0 }))
    expect(listPolicyFiles).not.toHaveBeenCalled()
  })
})
