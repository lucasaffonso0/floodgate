import 'server-only'

interface Bucket {
  count: number
  blockedUntil: number
  resetAt: number
}

const g = global as typeof global & { _rlBuckets?: Map<string, Bucket> }
if (!g._rlBuckets) g._rlBuckets = new Map()

const WINDOW_MS    = 60_000  // 1-minute window
const MAX_ATTEMPTS = 10      // max failures per window
const BLOCK_MS     = 5 * 60_000  // 5-minute block after exceeding limit

// Rate limit by username (per-account brute force protection).
// Per-IP would be safer against credential stuffing but is unreliable behind K8s NodePort (no x-forwarded-for).
export function checkRateLimit(key: string): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now()
  const buckets = g._rlBuckets!

  let b = buckets.get(key)

  if (b && b.blockedUntil > now) {
    return { allowed: false, retryAfterMs: b.blockedUntil - now }
  }

  if (!b || b.resetAt <= now) {
    b = { count: 0, blockedUntil: 0, resetAt: now + WINDOW_MS }
    buckets.set(key, b)
  }

  b.count++

  if (b.count > MAX_ATTEMPTS) {
    b.blockedUntil = now + BLOCK_MS
    return { allowed: false, retryAfterMs: BLOCK_MS }
  }

  return { allowed: true }
}

export function clearRateLimit(key: string) {
  g._rlBuckets?.delete(key)
}
