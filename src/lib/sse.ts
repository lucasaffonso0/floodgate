import 'server-only'

export type SSEEvent =
  | { type: 'approval_created';   id: string; created_by: string; allowed_approvers: Array<{ id: string; username: string }> }
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

const g = global as typeof global & { _sseWriters?: Set<Writer> }
if (!g._sseWriters) g._sseWriters = new Set()

export function addWriter(w: Writer)    { g._sseWriters!.add(w) }
export function removeWriter(w: Writer) { g._sseWriters!.delete(w) }
export function writerCount()           { return g._sseWriters!.size }

export function emit(event: SSEEvent) {
  if (!g._sseWriters || g._sseWriters.size === 0) return
  const chunk = `data: ${JSON.stringify(event)}\n\n`
  for (const w of g._sseWriters) {
    try { w(chunk) } catch { g._sseWriters!.delete(w) }
  }
}
