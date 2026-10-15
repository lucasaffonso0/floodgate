// Wraps an async job so a new run is skipped (not queued) while the
// previous one is still in flight. For setInterval-driven work, where a
// slow run (an unreachable git host, a slow K8s API, a big backup upload)
// would otherwise overlap with the next tick and run the same work twice
// at once. onSkip lets the caller count or log skipped runs.
export function nonOverlapping(fn: () => Promise<void>, onSkip?: () => void): () => Promise<void> {
  let running = false
  return async () => {
    if (running) {
      onSkip?.()
      return
    }
    running = true
    try {
      await fn()
    } finally {
      running = false
    }
  }
}
