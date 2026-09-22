import { describe, it, expect, vi, beforeEach } from 'vitest'
import yaml from 'js-yaml'

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
const createNamespacedNetworkPolicy = vi.fn()
const replaceNamespacedNetworkPolicy = vi.fn()

vi.mock('@kubernetes/client-node', () => {
  class KubeConfig {
    loadFromDefault() {}
    makeApiClient(ApiClass: unknown) {
      if (ApiClass === CoreV1Api) return { readNamespacedService, listNamespacedPod }
      if (ApiClass === AppsV1Api) return { readNamespacedDeployment, readNamespacedStatefulSet, readNamespacedDaemonSet }
      if (ApiClass === NetworkingV1Api) return { createNamespacedNetworkPolicy, replaceNamespacedNetworkPolicy }
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

// Real bug report: a flow discovered straight off a StatefulSet pod
// ("howk-scheduler" -> "gl-kafka-kafka-0") 404'd on "Ver YAML" — the
// *destination* side of every create/preview path required a Service with
// the exact request name, with no fallback at all (unlike the source side,
// which already had the resolveWorkload cascade). "gl-kafka-kafka-0" has no
// Service of that name (the real Services are gl-kafka-kafka-bootstrap /
// gl-kafka-kafka-brokers) and no StatefulSet of that name either (the real
// StatefulSet is "gl-kafka-kafka", without the pod's "-0" ordinal) — so it
// only resolves via the last-resort pod-label tier.
describe('destination resolution (createNetworkPolicy / previewPolicyYAML)', () => {
  const kafkaBrokerPod = {
    metadata: {
      name: 'gl-kafka-kafka-0',
      labels: {
        'app.kubernetes.io/name': 'kafka',
        'app.kubernetes.io/instance': 'gl-kafka',
        'strimzi.io/cluster': 'gl-kafka',
        'strimzi.io/name': 'gl-kafka-kafka',
        'controller-revision-hash': 'gl-kafka-kafka-abc123',
        'statefulset.kubernetes.io/pod-name': 'gl-kafka-kafka-0',
        // Auto-injected by Kubernetes 1.31+ on every StatefulSet pod — must
        // be filtered out, or the selector would only ever match this one
        // replica (confirmed live against a real kind cluster on 1.32).
        'apps.kubernetes.io/pod-index': '0',
      },
    },
  }
  const request = {
    src_workload: 'howk-scheduler', src_namespace: 'howk',
    dst_service: 'gl-kafka-kafka-0', dst_namespace: 'kafka',
    dst_ports: [{ port: 9092, protocol: 'TCP' as const }],
  }

  it('previewPolicyYAML falls through to the destination pod\'s identity labels and keeps the given numeric port as-is', async () => {
    // Source resolves normally via a Service — isolates this test to the
    // destination-side fallback specifically, which is what actually broke.
    readNamespacedService.mockImplementation(({ name }: { name: string }) =>
      name === 'howk-scheduler'
        ? Promise.resolve({ spec: { selector: { app: 'howk-scheduler' } } })
        : Promise.reject(notFound())
    )
    readNamespacedDeployment.mockRejectedValue(notFound())
    readNamespacedStatefulSet.mockRejectedValue(notFound())
    readNamespacedDaemonSet.mockRejectedValue(notFound())
    listNamespacedPod.mockResolvedValue({ items: [kafkaBrokerPod] })

    const { previewPolicyYAML } = await import('./k8s')
    const text = await previewPolicyYAML(request, 'ingress')
    const doc = yaml.load(text) as { spec: { podSelector: { matchLabels: Record<string, string> }; ingress: Array<{ ports: Array<{ port: number }> }> } }

    expect(doc.spec.podSelector.matchLabels).toEqual({
      'app.kubernetes.io/name': 'kafka',
      'app.kubernetes.io/instance': 'gl-kafka',
      'strimzi.io/cluster': 'gl-kafka',
      'strimzi.io/name': 'gl-kafka-kafka',
    })
    // No Service exists to resolve a named targetPort against — the given
    // numeric port (already the real port, straight from an observed
    // Hubble flow) must pass through unchanged, not be dropped or error.
    expect(doc.spec.ingress[0].ports[0].port).toBe(9092)
  })

  it('createNetworkPolicy applies the same destination fallback when actually creating the policy, not just previewing it', async () => {
    readNamespacedService.mockImplementation(({ name }: { name: string }) =>
      name === 'howk-scheduler'
        ? Promise.resolve({ spec: { selector: { app: 'howk-scheduler' } } })
        : Promise.reject(notFound())
    )
    readNamespacedDeployment.mockRejectedValue(notFound())
    readNamespacedStatefulSet.mockRejectedValue(notFound())
    readNamespacedDaemonSet.mockRejectedValue(notFound())
    listNamespacedPod.mockResolvedValue({ items: [kafkaBrokerPod] })
    createNamespacedNetworkPolicy.mockResolvedValue({ metadata: { name: 'floodgate-allow-x', namespace: 'kafka', creationTimestamp: new Date() } })

    const { createNetworkPolicy } = await import('./k8s')
    const result = await createNetworkPolicy(request)

    expect(result.dst_service).toBe('gl-kafka-kafka-0')
    const body = createNamespacedNetworkPolicy.mock.calls[0][0].body
    expect(body.spec.podSelector.matchLabels).toEqual({
      'app.kubernetes.io/name': 'kafka',
      'app.kubernetes.io/instance': 'gl-kafka',
      'strimzi.io/cluster': 'gl-kafka',
      'strimzi.io/name': 'gl-kafka-kafka',
    })
    expect(body.spec.ingress[0].ports[0].port).toBe(9092)
  })
})
