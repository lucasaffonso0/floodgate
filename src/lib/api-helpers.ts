import 'server-only'
import { NextRequest, NextResponse } from 'next/server'

// Errors whose message is safe and useful to show to the end user
// (thrown deliberately by our own code, e.g. k8s.ts validations).
export class UserFacingError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

function k8sStatusOf(e: unknown): number | undefined {
  const err = e as { statusCode?: number; body?: unknown }
  if (typeof err.statusCode === 'number') return err.statusCode
  try {
    const body = typeof err.body === 'string' ? JSON.parse(err.body) : err.body
    if (typeof (body as { code?: number })?.code === 'number') return (body as { code: number }).code
  } catch {}
  return undefined
}

// Logs the full error server-side and returns a generic message: raw
// K8s/SQLite errors leak cluster paths and internals to clients.
export function apiError(e: unknown, detail = 'Erro interno', status = 500): NextResponse {
  if (e instanceof UserFacingError) {
    return NextResponse.json({ detail: e.message }, { status: e.status })
  }
  if (k8sStatusOf(e) === 404) {
    return NextResponse.json({ detail: 'Recurso não encontrado no cluster' }, { status: 404 })
  }
  console.error('[floodgate] API error:', e)
  return NextResponse.json({ detail }, { status })
}

// Malformed/empty JSON bodies must be a 400, not an unhandled 500.
export async function parseBody<T = Record<string, unknown>>(req: NextRequest): Promise<T | null> {
  try {
    return await req.json() as T
  } catch {
    return null
  }
}

// Validates a dst_ports array shape shared by every policy-creation route:
// port/endPort must be integers 1-65535, and endPort (when present) must be
// >= port. An empty/absent array is valid: it means "all ports".
export function invalidPortsMessage(dstPorts: unknown): string | null {
  if (dstPorts === undefined) return null
  if (!Array.isArray(dstPorts)) return "'dst_ports' deve ser um array"
  for (const p of dstPorts) {
    const port = (p as { port?: unknown })?.port
    const endPort = (p as { endPort?: unknown })?.endPort
    if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535)
      return `porta inválida: ${JSON.stringify(port)} (deve ser 1-65535)`
    if (endPort !== undefined) {
      if (!Number.isInteger(endPort) || (endPort as number) < 1 || (endPort as number) > 65535)
        return `endPort inválido: ${JSON.stringify(endPort)} (deve ser 1-65535)`
      if ((endPort as number) < (port as number))
        return `endPort (${endPort}) não pode ser menor que port (${port})`
    }
  }
  return null
}
