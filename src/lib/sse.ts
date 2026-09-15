import 'server-only'

export type SSEEvent =
  | { type: 'approval_created';   id: string; created_by: string; allowed_approver_ids: string[] }
  | { type: 'approval_applied';   id: string }
  | { type: 'approval_voted';     id: string }
  | { type: 'approval_rejected';  id: string }
  | { type: 'approval_cancelled'; id: string }
  | { type: 'policy_created' }
  | { type: 'policy_deleted' }
  | { type: 'policies_paused' }
  | { type: 'policies_resumed' }
  | { type: 'hubble_flow_new' }

type Writer = (chunk: string) => void

const g = global as typeof global & { _sseWriters?: Set<Writer>; _sseHeartbeat?: ReturnType<typeof setInterval> }
if (!g._sseWriters) g._sseWriters = new Set()

// Heartbeat prunes writers whose connections died silently (proxy drops
// without cancel()): otherwise, during quiet periods with no events, dead
// writers accumulate until the connection cap rejects new clients.
const HEARTBEAT_MS = 30_000
function ensureHeartbeat() {
  if (g._sseHeartbeat) return
  g._sseHeartbeat = setInterval(() => {
    const writers = g._sseWriters!
    if (writers.size === 0) return
    for (const w of writers) {
      try { w(': ping\n\n') } catch { writers.delete(w) }
    }
  }, HEARTBEAT_MS)
  g._sseHeartbeat.unref?.()
}

export function addWriter(w: Writer)    { ensureHeartbeat(); g._sseWriters!.add(w) }
export function removeWriter(w: Writer) { g._sseWriters!.delete(w) }
export function writerCount()           { return g._sseWriters!.size }

export function emit(event: SSEEvent) {
  if (!g._sseWriters || g._sseWriters.size === 0) return
  const chunk = `data: ${JSON.stringify(event)}\n\n`
  for (const w of g._sseWriters) {
    try { w(chunk) } catch { g._sseWriters!.delete(w) }
  }
}
