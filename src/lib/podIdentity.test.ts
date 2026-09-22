import { describe, it, expect } from 'vitest'
import { isIdentityLabel, identityLabels } from './podIdentity'

describe('isIdentityLabel', () => {
  it('keeps the standard app.kubernetes.io/* identity labels', () => {
    expect(isIdentityLabel('app.kubernetes.io/name')).toBe(true)
    expect(isIdentityLabel('app.kubernetes.io/instance')).toBe(true)
    expect(isIdentityLabel('app.kubernetes.io/component')).toBe(true)
  })

  it('keeps a custom chart-defined domain label', () => {
    // Real example: defectdojo's Helm chart labels the celery worker with
    // defectdojo.org/component=celery, defectdojo.org/subcomponent=worker —
    // this is what distinguishes it from every other pod in the release.
    expect(isIdentityLabel('defectdojo.org/component')).toBe(true)
    expect(isIdentityLabel('defectdojo.org/subcomponent')).toBe(true)
  })

  it('keeps flat, unprefixed legacy labels', () => {
    expect(isIdentityLabel('app')).toBe(true)
    expect(isIdentityLabel('component')).toBe(true)
    expect(isIdentityLabel('tier')).toBe(true)
  })

  it('drops pod-template-hash — regenerated on every Deployment rollout', () => {
    expect(isIdentityLabel('pod-template-hash')).toBe(false)
  })

  it('drops controller-revision-hash — regenerated on every StatefulSet/DaemonSet rollout', () => {
    expect(isIdentityLabel('controller-revision-hash')).toBe(false)
  })

  it('drops statefulset.kubernetes.io/pod-name — unique per pod, not a shared selector', () => {
    expect(isIdentityLabel('statefulset.kubernetes.io/pod-name')).toBe(false)
  })

  it('drops Job-owned pod labels — unique per Job run, not per app', () => {
    expect(isIdentityLabel('batch.kubernetes.io/job-name')).toBe(false)
    expect(isIdentityLabel('job-name')).toBe(false)
    expect(isIdentityLabel('batch.kubernetes.io/job-completion-index')).toBe(false)
    expect(isIdentityLabel('controller-uid')).toBe(false)
  })

  it('drops apps.kubernetes.io/pod-index — the StatefulSet ordinal Kubernetes 1.31+ auto-injects onto every pod', () => {
    // Real bug: a Kafka StatefulSet pod ("gl-kafka-kafka-0") with no
    // Service resolved via this last-resort tier, and this label — not
    // filtered before this fix — narrowed the generated NetworkPolicy's
    // selector down to just that one replica instead of every broker.
    expect(isIdentityLabel('apps.kubernetes.io/pod-index')).toBe(false)
  })

  it('keeps apps.kubernetes.io/* labels other than pod-index (distinct prefix from app.kubernetes.io/*, not caught by that allowlist)', () => {
    expect(isIdentityLabel('apps.kubernetes.io/pod-index')).toBe(false)
    // Sanity: confirm the two prefixes really are handled independently —
    // a typo collapsing "apps." into the "app." allowlist check would
    // silently keep pod-index again.
    expect(isIdentityLabel('app.kubernetes.io/name')).toBe(true)
  })

  it('drops node-topology labels — describe where the pod runs, not what it is', () => {
    expect(isIdentityLabel('topology.kubernetes.io/region')).toBe(false)
    expect(isIdentityLabel('topology.kubernetes.io/zone')).toBe(false)
    expect(isIdentityLabel('failure-domain.beta.kubernetes.io/zone')).toBe(false)
    expect(isIdentityLabel('kubernetes.io/hostname')).toBe(false)
  })

  it('drops unrecognized kubernetes.io/k8s.io labels — almost always system metadata', () => {
    expect(isIdentityLabel('kubernetes.io/arch')).toBe(false)
    expect(isIdentityLabel('k8s.io/some-internal-thing')).toBe(false)
  })
})

describe('identityLabels', () => {
  it('filters a real defectdojo-celery-worker label set down to just the identity labels', () => {
    // Captured live from `kubectl get pod ... --show-labels` on the exact
    // pod that exposed this bug: a worker with no Service, whose podSelector
    // has to be built from its own labels.
    const raw = {
      'app.kubernetes.io/instance': 'defectdojo',
      'app.kubernetes.io/name': 'defectdojo',
      'defectdojo.org/component': 'celery',
      'defectdojo.org/subcomponent': 'worker',
      'pod-template-hash': '744f7948dc',
      'topology.kubernetes.io/region': 'nyc1',
    }
    expect(identityLabels(raw)).toEqual({
      'app.kubernetes.io/instance': 'defectdojo',
      'app.kubernetes.io/name': 'defectdojo',
      'defectdojo.org/component': 'celery',
      'defectdojo.org/subcomponent': 'worker',
    })
  })

  it('filters a real gl-kafka-kafka-0 (StatefulSet, Strimzi) label set down to just the identity labels', () => {
    // Captured live from `kubectl get pod gl-kafka-kafka-0 --show-labels`
    // on the exact pod from the reported bug — a Kafka broker with no
    // matching Service (bootstrap/brokers Services have different names)
    // and no matching StatefulSet either (the StatefulSet is
    // "gl-kafka-kafka", without the pod's "-0" ordinal).
    const raw = {
      'app.kubernetes.io/instance': 'gl-kafka',
      'app.kubernetes.io/name': 'kafka',
      'apps.kubernetes.io/pod-index': '0',
      'controller-revision-hash': 'gl-kafka-kafka-6d7fd75c96',
      'statefulset.kubernetes.io/pod-name': 'gl-kafka-kafka-0',
      'strimzi.io/cluster': 'gl-kafka',
      'strimzi.io/name': 'gl-kafka-kafka',
    }
    expect(identityLabels(raw)).toEqual({
      'app.kubernetes.io/instance': 'gl-kafka',
      'app.kubernetes.io/name': 'kafka',
      'strimzi.io/cluster': 'gl-kafka',
      'strimzi.io/name': 'gl-kafka-kafka',
    })
  })

  it('returns an empty object when every label is generated/topology noise', () => {
    expect(identityLabels({ 'pod-template-hash': 'abc12', 'kubernetes.io/hostname': 'node-1' })).toEqual({})
  })

  it('returns an empty object for an empty label map', () => {
    expect(identityLabels({})).toEqual({})
  })
})
