// Labels that identify WHAT a pod is, as opposed to labels Kubernetes (or a
// controller) generates per rollout/schedule and that would stop matching
// after the next deploy, or that describe WHERE it's running rather than
// what it is. Used by resolvePodSelector's last-resort tier (src/lib/k8s.ts)
// when a workload has no Service and no matching Deployment/StatefulSet/
// DaemonSet to ask for an authoritative selector — a live pod's own labels
// are the only thing left to build a podSelector from, so getting this
// filter wrong risks a NetworkPolicy that's either too broad (matches pods
// it shouldn't) or too narrow (stops matching after the next rollout).
const GENERATED_LABEL_KEYS = new Set([
  'pod-template-hash',
  'controller-revision-hash',
  'statefulset.kubernetes.io/pod-name',
  'batch.kubernetes.io/job-name',
  'job-name',
])

export function isIdentityLabel(key: string): boolean {
  if (GENERATED_LABEL_KEYS.has(key)) return false
  if (key.startsWith('topology.kubernetes.io/')) return false
  if (key.startsWith('failure-domain.beta.kubernetes.io/')) return false
  if (key === 'kubernetes.io/hostname') return false
  // app.kubernetes.io/* is the Kubernetes-recommended identity label set —
  // keep it even though it shares the kubernetes.io domain the two checks
  // below exclude generically (unrecognized kubernetes.io/k8s.io labels are
  // almost always system/node metadata, not app identity).
  if (key.startsWith('app.kubernetes.io/')) return true
  if (key.startsWith('kubernetes.io/') || key.startsWith('k8s.io/')) return false
  return true
}

// Applies isIdentityLabel to a full label map, as resolvePodSelector does.
export function identityLabels(labels: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(labels).filter(([k]) => isIdentityLabel(k)))
}
