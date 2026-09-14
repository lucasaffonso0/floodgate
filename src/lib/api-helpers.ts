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

// Logs the full error server-side and returns a generic message — raw
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
