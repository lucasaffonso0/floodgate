import { describe, it, expect, vi, beforeEach } from 'vitest'

// 'server-only' isn't a real package — it's a Next.js build-time marker with
// no runtime module behind it outside Next's own bundler, so importing
// k8s.ts directly (as this file does) needs it stubbed out first.
vi.mock('server-only', () => ({}))

// resolvePodSelector's whole point is the fallback order — Service, then
// Deployment/StatefulSet/DaemonSet, then a live pod's own labels — and that
// a non-404 error (permissions, network) stops the cascade immediately
// instead of silently trying the next tier. That's easiest to pin down
// against a mocked client: a live-cluster test can exercise the "not
// found" path but not a permissions error without actually breaking RBAC.
const readNamespacedService = vi.fn()
const listNamespacedPod = vi.fn()
const readNamespacedDeployment = vi.fn()
const readNamespacedStatefulSet = vi.fn()
const readNamespacedDaemonSet = vi.fn()

vi.mock('@kubernetes/client-node', () => {
  class KubeConfig {
    loadFromDefault() {}
    makeApiClient(ApiClass: unknown) {
      if (ApiClass === CoreV1Api) return { readNamespacedService, listNamespacedPod }
      if (ApiClass === AppsV1Api) return { readNamespacedDeployment, readNamespacedStatefulSet, readNamespacedDaemonSet }
      return {}
    }
  }
  class CoreV1Api {}
  class AppsV1Api {}
  class NetworkingV1Api {}
  return { KubeConfig, CoreV1Api, AppsV1Api, NetworkingV1Api }
})

const notFound = () => Object.assign(new Error('not found'), { statusCode: 404 })
const forbidden = () => Object.assign(new Error('forbidden'), { statusCode: 403 })

beforeEach(() => {
  // resetAllMocks (not clearAllMocks) — each test sets its own
  // mockResolvedValue/mockRejectedValue per tier, and a leftover
  // implementation from a previous test would silently change which tier
  // "wins" instead of the test failing loudly.
  vi.resetAllMocks()
})

describe('resolvePodSelector', () => {
  it('uses the Service selector when a Service with that name exists', async () => {
    readNamespacedService.mockResolvedValue({ spec: { selector: { app: 'django' } } })
    const { resolvePodSelector } = await import('./k8s')
    await expect(resolvePodSelector('defectdojo-django', 'defectdojo')).resolves.toEqual({ app: 'django' })
    expect(readNamespacedDeployment).not.toHaveBeenCalled()
  })

  it('falls back to the Deployment selector when no Service exists (404)', async () => {
    readNamespacedService.mockRejectedValue(notFound())
    readNamespacedDeployment.mockResolvedValue({ spec: { selector: { matchLabels: { app: 'celery-worker' } } } })
    const { resolvePodSelector } = await import('./k8s')
    await expect(resolvePodSelector('defectdojo-celery-worker', 'defectdojo')).resolves.toEqual({ app: 'celery-worker' })
    expect(readNamespacedStatefulSet).not.toHaveBeenCalled()
  })

  it('falls back to the StatefulSet selector when no Service or Deployment exists', async () => {
    readNamespacedService.mockRejectedValue(notFound())
    readNamespacedDeployment.mockRejectedValue(notFound())
    readNamespacedStatefulSet.mockResolvedValue({ spec: { selector: { matchLabels: { app: 'postgresql' } } } })
    const { resolvePodSelector } = await import('./k8s')
    await expect(resolvePodSelector('postgresql', 'defectdojo')).resolves.toEqual({ app: 'postgresql' })
    expect(readNamespacedDaemonSet).not.toHaveBeenCalled()
  })

  it('falls back to the DaemonSet selector when nothing else matches', async () => {
    readNamespacedService.mockRejectedValue(notFound())
    readNamespacedDeployment.mockRejectedValue(notFound())
    readNamespacedStatefulSet.mockRejectedValue(notFound())
    readNamespacedDaemonSet.mockResolvedValue({ spec: { selector: { matchLabels: { app: 'log-agent' } } } })
    const { resolvePodSelector } = await import('./k8s')
    await expect(resolvePodSelector('log-agent', 'defectdojo')).resolves.toEqual({ app: 'log-agent' })
    expect(listNamespacedPod).not.toHaveBeenCalled()
  })

  it('falls back to a live pod\'s own identity labels as the last resort', async () => {
    readNamespacedService.mockRejectedValue(notFound())
    readNamespacedDeployment.mockRejectedValue(notFound())
    readNamespacedStatefulSet.mockRejectedValue(notFound())
    readNamespacedDaemonSet.mockRejectedValue(notFound())
    listNamespacedPod.mockResolvedValue({
      items: [
        {
          metadata: {
            name: 'bare-runner-abcde',
            labels: { 'app.kubernetes.io/name': 'reporter', 'pod-template-hash': 'xyz12' },
          },
        },
      ],
    })
    const { resolvePodSelector } = await import('./k8s')
    await expect(resolvePodSelector('bare-runner-abcde', 'defectdojo')).resolves.toEqual({ 'app.kubernetes.io/name': 'reporter' })
  })

  it('matches the last-resort pod by its normalized name (strips the ReplicaSet/pod hash suffix)', async () => {
    readNamespacedService.mockRejectedValue(notFound())
    readNamespacedDeployment.mockRejectedValue(notFound())
    readNamespacedStatefulSet.mockRejectedValue(notFound())
    readNamespacedDaemonSet.mockRejectedValue(notFound())
    listNamespacedPod.mockResolvedValue({
      items: [
        { metadata: { name: 'worker-6949b89dcc-9w42f', labels: { app: 'worker' } } },
      ],
    })
    const { resolvePodSelector } = await import('./k8s')
    await expect(resolvePodSelector('worker', 'defectdojo')).resolves.toEqual({ app: 'worker' })
  })

  it('throws when no Service, controller, or matching pod exists anywhere', async () => {
    readNamespacedService.mockRejectedValue(notFound())
    readNamespacedDeployment.mockRejectedValue(notFound())
    readNamespacedStatefulSet.mockRejectedValue(notFound())
    readNamespacedDaemonSet.mockRejectedValue(notFound())
    listNamespacedPod.mockResolvedValue({ items: [] })
    const { resolvePodSelector } = await import('./k8s')
    await expect(resolvePodSelector('ghost', 'defectdojo')).rejects.toThrow(/Não foi possível encontrar/)
  })

  it('throws when the matched pod has no usable identity labels, instead of an empty (namespace-wide) selector', async () => {
    readNamespacedService.mockRejectedValue(notFound())
    readNamespacedDeployment.mockRejectedValue(notFound())
    readNamespacedStatefulSet.mockRejectedValue(notFound())
    readNamespacedDaemonSet.mockRejectedValue(notFound())
    listNamespacedPod.mockResolvedValue({
      items: [{ metadata: { name: 'bare-abcde', labels: { 'pod-template-hash': 'abcde' } } }],
    })
    const { resolvePodSelector } = await import('./k8s')
    await expect(resolvePodSelector('bare-abcde', 'defectdojo')).rejects.toThrow(/não tem labels suficientes/)
  })

  it('propagates a non-404 error (e.g. missing RBAC permission) immediately, without trying the next tier', async () => {
    readNamespacedService.mockRejectedValue(notFound())
    readNamespacedDeployment.mockRejectedValue(forbidden())
    const { resolvePodSelector } = await import('./k8s')
    await expect(resolvePodSelector('celery-worker', 'defectdojo')).rejects.toThrow('forbidden')
    expect(readNamespacedStatefulSet).not.toHaveBeenCalled()
    expect(readNamespacedDaemonSet).not.toHaveBeenCalled()
    expect(listNamespacedPod).not.toHaveBeenCalled()
  })

  it('propagates a non-404 error from the Service lookup itself without trying any fallback tier', async () => {
    readNamespacedService.mockRejectedValue(forbidden())
    const { resolvePodSelector } = await import('./k8s')
    await expect(resolvePodSelector('django', 'defectdojo')).rejects.toThrow('forbidden')
    expect(readNamespacedDeployment).not.toHaveBeenCalled()
  })
})
