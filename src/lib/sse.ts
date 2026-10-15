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
  | { type: 'hubble_flow_new'; version: string }

type Writer = (chunk: string) => void

const g = global as typeof global & { _sseWriters?: Set<Writer>; _sseHeartbeat?: ReturnType<typeof setInterval>; _sseFlushTimer?: ReturnType<typeof setTimeout> }
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

function broadcast(event: SSEEvent) {
  if (!g._sseWriters || g._sseWriters.size === 0) return
  const chunk = `data: ${JSON.stringify(event)}\n\n`
  for (const w of g._sseWriters) {
    try { w(chunk) } catch { g._sseWriters!.delete(w) }
  }
}

// Change notifications are coalesced into one window: a bulk action (apply
// all drafts, isolate N namespaces, import) emits one event per policy, and
// every client answers each event with a full refresh. Identical events in
// the window collapse into one; distinct ones are all still delivered, in
// order. approval_created goes out immediately: it drives a toast and
// carries a payload specific to that request.
const COALESCE_MS = 500
const pending = (g as typeof g & { _ssePending?: Map<string, SSEEvent> })
function pendingEvents(): Map<string, SSEEvent> {
  return (pending._ssePending ??= new Map())
}

function flushPending() {
  g._sseFlushTimer = undefined
  const events = [...pendingEvents().values()]
  pendingEvents().clear()
  for (const e of events) broadcast(e)
}

export function emit(event: SSEEvent) {
  if (!g._sseWriters || g._sseWriters.size === 0) return
  if (event.type === 'approval_created') { broadcast(event); return }
  pendingEvents().set(JSON.stringify(event), event)
  if (!g._sseFlushTimer) {
    g._sseFlushTimer = setTimeout(flushPending, COALESCE_MS)
    g._sseFlushTimer.unref?.()
  }
}
