import 'server-only'
import * as k8s from '@kubernetes/client-node'
import { invalidateReads } from './readCache'
import { perfCount } from './perfMetrics'

// Watch-fed (informer) copies of the cluster-wide lists floodgate reads all
// the time: Services, NetworkPolicies and Namespaces. One initial list each,
// then the API server streams changes, so a read is an in-memory lookup
// instead of listing the whole cluster again. With thousands of Services
// that's the difference between a multi-megabyte list call every few
// seconds and none at all.
//
// - Reads go through watchedItems(): it returns null until the informer has
//   finished its first list (or while it's reconnecting after an error), and
//   callers then fall back to a plain list call, so nothing breaks while the
//   watch is down.
// - Any change invalidates the read cache (readCache.ts), coalesced over a
//   short window, so a list derived from these copies reflects it right
//   away instead of after the cache TTL.
// - FLOODGATE_K8S_WATCH=0 turns this off (plain list calls, as before).
// State lives on `global`: Next bundles routes separately and each bundle
// would otherwise open its own set of watches.

export type WatchedKind = 'services' | 'networkpolicies' | 'namespaces' | 'pods'

type Entry = {
  informer: k8s.Informer<k8s.KubernetesObject> & k8s.ObjectCache<k8s.KubernetesObject>
  synced: boolean
}

type State = {
  entries: Partial<Record<WatchedKind, Entry>>
  invalidateTimer?: ReturnType<typeof setTimeout>
}

const g = global as typeof global & { _floodgateK8sWatch?: State }
function state(): State {
  return (g._floodgateK8sWatch ??= { entries: {} })
}

const RESTART_DELAY_MS = 5_000
const MAX_RESTART_DELAY_MS = 120_000
const INVALIDATE_COALESCE_MS = 250

function watchEnabled(): boolean {
  if (process.env.FLOODGATE_K8S_WATCH === '0') return false
  // A mocked client (unit tests) may not have it at all, and some mocking
  // setups throw on reading a missing export instead of returning undefined.
  try { return typeof k8s.makeInformer === 'function' } catch { return false }
}

function scheduleInvalidate() {
  const s = state()
  if (s.invalidateTimer) return
  s.invalidateTimer = setTimeout(() => {
    s.invalidateTimer = undefined
    invalidateReads()
  }, INVALIDATE_COALESCE_MS)
  s.invalidateTimer.unref?.()
}

const PATHS: Record<WatchedKind, string> = {
  services: '/api/v1/services',
  networkpolicies: '/apis/networking.k8s.io/v1/networkpolicies',
  namespaces: '/api/v1/namespaces',
  pods: '/api/v1/pods',
}

// Pods change all the time (status, restarts) and no cached list is built
// from them: their events must not invalidate the read cache.
const INVALIDATES_READS: Record<WatchedKind, boolean> = { services: true, networkpolicies: true, namespaces: true, pods: false }

function start(kind: WatchedKind, kc: k8s.KubeConfig, list: () => Promise<k8s.KubernetesListObject<k8s.KubernetesObject>>): void {
  const informer = k8s.makeInformer(kc, PATHS[kind], list)
  const entry: Entry = { informer, synced: false }
  state().entries[kind] = entry

  const onChange = () => { perfCount(`k8s.watch_event_${kind}`); if (INVALIDATES_READS[kind]) scheduleInvalidate() }
  informer.on('add', onChange)
  informer.on('update', onChange)
  informer.on('delete', onChange)
  // The API server closes every watch after a while (about every 10 minutes
  // on a typical cluster), so an error here is usually routine: reconnect
  // quietly. Only a reconnect that itself fails is logged, and it keeps
  // retrying with a growing delay (a failed restart used to be swallowed,
  // leaving the watch off until the pod restarted).
  const restart = (attempt: number) => {
    setTimeout(() => {
      informer.start()
        .then(() => {
          entry.synced = true
          scheduleInvalidate()
          if (attempt > 0) console.log(`[k8s-watch] ${kind}: watch restabelecido`)
        })
        .catch(err => {
          const next = Math.min(RESTART_DELAY_MS * 2 ** (attempt + 1), MAX_RESTART_DELAY_MS)
          console.warn(`[k8s-watch] ${kind}: falha ao reconectar, nova tentativa em ${next / 1000}s (leituras usam list direto enquanto isso):`, (err as Error)?.message ?? err)
          restart(attempt + 1)
        })
    }, Math.min(RESTART_DELAY_MS * 2 ** attempt, MAX_RESTART_DELAY_MS)).unref?.()
  }
  informer.on('error', () => {
    // The cache may now miss changes: stop serving from it until the
    // restarted watch has re-listed.
    entry.synced = false
    perfCount(`k8s.watch_reconnect_${kind}`)
    restart(0)
  })

  informer.start()
    .then(() => { entry.synced = true; scheduleInvalidate() })
    .catch(err => console.warn(`[k8s-watch] ${kind}: falha ao iniciar, usando list direto:`, (err as Error)?.message ?? err))
}

// Objects from the initial list come deserialized by the client (Date
// timestamps, `_from` for an ingress rule's `from`), but objects from watch
// events arrive as plain JSON. Brings the plain ones to the same shape, so
// callers never see a mix (e.g. calling toISOString() on a string).
function asTyped(kind: WatchedKind, obj: k8s.KubernetesObject): k8s.KubernetesObject {
  const ts = obj.metadata?.creationTimestamp as unknown
  if (typeof ts !== 'string') return obj
  const typed = { ...obj, metadata: { ...obj.metadata, creationTimestamp: new Date(ts) } } as k8s.KubernetesObject & { spec?: k8s.V1NetworkPolicySpec }
  if (kind === 'networkpolicies' && typed.spec?.ingress) {
    typed.spec = {
      ...typed.spec,
      ingress: typed.spec.ingress.map(rule => {
        const { from, ...rest } = rule as typeof rule & { from?: k8s.V1NetworkPolicyPeer[] }
        return from !== undefined && rule._from === undefined ? { ...rest, _from: from } : rule
      }),
    }
  }
  return typed
}

// The current watched copy of `kind`, or null when it isn't usable yet
// (caller falls back to listing). Starts the watch on first use.
export function watchedItems<T extends k8s.KubernetesObject>(
  kind: WatchedKind,
  kc: k8s.KubeConfig,
  list: () => Promise<k8s.KubernetesListObject<k8s.KubernetesObject>>,
): T[] | null {
  if (!watchEnabled()) return null
  const entry = state().entries[kind]
  if (!entry) {
    try { start(kind, kc, list) } catch (err) {
      console.warn(`[k8s-watch] ${kind}: não foi possível criar o watch:`, err)
    }
    return null
  }
  if (!entry.synced) return null
  perfCount(`k8s.watch_read_${kind}`)
  return entry.informer.list().map(o => asTyped(kind, o)) as T[]
}

export const __testing = { asTyped }
