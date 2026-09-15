import 'server-only'

interface Bucket {
  count: number
  blockedUntil: number
  resetAt: number
}

const g = global as typeof global & { _rlBuckets?: Map<string, Bucket>; _rlLastSweep?: number }
if (!g._rlBuckets) g._rlBuckets = new Map()

const WINDOW_MS        = 60_000      // 1-minute window
const MAX_ATTEMPTS     = 10          // max failures per window per username
const BLOCK_MS         = 5 * 60_000 // 5-minute block after exceeding limit
const IP_MAX_ATTEMPTS  = 30          // stricter limit per IP (covers credential stuffing)

const SWEEP_INTERVAL_MS = 5 * 60_000

// Opportunistic sweep of expired buckets: the map is otherwise only cleaned
// on successful login, so failed attempts with random usernames/IPs would
// grow it without bound (memory-exhaustion DoS).
function sweepExpired(now: number) {
  const buckets = g._rlBuckets!
  if (now - (g._rlLastSweep ?? 0) < SWEEP_INTERVAL_MS) return
  g._rlLastSweep = now
  for (const [key, b] of buckets) {
    if (b.resetAt <= now && b.blockedUntil <= now) buckets.delete(key)
  }
}

function checkBucket(key: string, max: number): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now()
  const buckets = g._rlBuckets!
  sweepExpired(now)

  let b = buckets.get(key)

  if (b && b.blockedUntil > now) {
    return { allowed: false, retryAfterMs: b.blockedUntil - now }
  }

  if (!b || b.resetAt <= now) {
    b = { count: 0, blockedUntil: 0, resetAt: now + WINDOW_MS }
    buckets.set(key, b)
  }

  b.count++

  if (b.count > max) {
    b.blockedUntil = now + BLOCK_MS
    return { allowed: false, retryAfterMs: BLOCK_MS }
  }

  return { allowed: true }
}

export function checkRateLimit(key: string): { allowed: boolean; retryAfterMs?: number } {
  return checkBucket(key, MAX_ATTEMPTS)
}

export function checkIpRateLimit(ip: string): { allowed: boolean; retryAfterMs?: number } {
  return checkBucket(`ip:${ip}`, IP_MAX_ATTEMPTS)
}

export function clearRateLimit(key: string) {
  g._rlBuckets?.delete(key)
}
