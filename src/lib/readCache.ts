import 'server-only'
import { perfCount } from './perfMetrics'

// Short-lived shared cache for expensive cluster/repo reads (listing every
// Service or NetworkPolicy in the cluster, merging GitOps sync status from
// the repo). Without it every open browser re-listed the whole cluster on
// each 15s poll, plus the scheduler and Hubble did the same on their own.
//
// - TTL bounds staleness for changes made OUTSIDE floodgate (kubectl,
//   ArgoCD, someone pushing to the repo).
// - Changes made BY floodgate call invalidateReads() at the write site
//   (k8s.ts's NetworkPolicy client, k8s-gitops.ts's commit path, the repo
//   refresh), so a user never sees their own action missing.
// - Generation counter: a read that started before an invalidation must
//   not store its (now possibly stale) result, and a caller arriving after
//   it must not join that in-flight read.
// - Concurrent callers of the same key share one in-flight read.
// State lives on `global` because Next bundles each route separately: a
// module-level Map would give every route its own cache, and an
// invalidation in one route would not reach the others.
type Entry = { value: unknown; at: number; gen: number }
type State = { gen: number; entries: Map<string, Entry>; inflight: Map<string, { promise: Promise<unknown>; gen: number }> }

const g = global as typeof global & { _floodgateReadCache?: State }

function state(): State {
  if (!g._floodgateReadCache) g._floodgateReadCache = { gen: 0, entries: new Map(), inflight: new Map() }
  return g._floodgateReadCache
}

// Arrays come back as a shallow copy so a caller sorting or filtering in
// place can't corrupt what the next caller gets.
function copy<T>(value: T): T {
  return (Array.isArray(value) ? [...value] : value) as T
}

export async function cachedRead<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const s = state()
  const hit = s.entries.get(key)
  if (hit && hit.gen === s.gen && Date.now() - hit.at < ttlMs) {
    perfCount('cache.hit')
    return copy(hit.value as T)
  }
  const inflight = s.inflight.get(key)
  if (inflight && inflight.gen === s.gen) {
    perfCount('cache.joined')
    return copy(await (inflight.promise as Promise<T>))
  }

  perfCount('cache.miss')
  const gen = s.gen
  const promise = load()
  s.inflight.set(key, { promise, gen })
  try {
    const value = await promise
    if (s.gen === gen) s.entries.set(key, { value, at: Date.now(), gen })
    return copy(value)
  } finally {
    if (s.inflight.get(key)?.promise === promise) s.inflight.delete(key)
  }
}

export function invalidateReads(): void {
  const s = state()
  s.gen++
  s.entries.clear()
  s.inflight.clear()
}

export function readGeneration(): number {
  return state().gen
}
