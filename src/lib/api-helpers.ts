import 'server-only'
import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { gzip } from 'zlib'
import { promisify } from 'util'

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

// Next doesn't compress route handler responses, and the big ones (the
// flow list, Services/NetworkPolicies on a large cluster) are very
// repetitive JSON that gzips around 10x. Compressed off the main thread
// (zlib's async API runs in the libuv pool), only above a size where it
// pays off, and only for clients that ask for it.
const gzipAsync = promisify(gzip)
const COMPRESS_ABOVE_BYTES = 16 * 1024

export function acceptsGzip(req: NextRequest | Request): boolean {
  return /\bgzip\b/.test(req.headers.get('accept-encoding') ?? '')
}

export async function gzipBody(body: string): Promise<Buffer> {
  return gzipAsync(body)
}

// Response for an already-serialized JSON body, gzipped when worthwhile.
// `gz` lets a caller pass a pre-compressed copy it keeps cached.
export async function jsonBody(
  req: NextRequest | Request, body: string, headers: Record<string, string> = {}, gz?: Buffer,
): Promise<NextResponse> {
  const base = { ...headers, 'Content-Type': 'application/json', Vary: 'Accept-Encoding' }
  if (body.length >= COMPRESS_ABOVE_BYTES && acceptsGzip(req)) {
    const compressed = gz ?? await gzipAsync(body)
    return new NextResponse(new Uint8Array(compressed), { status: 200, headers: { ...base, 'Content-Encoding': 'gzip' } })
  }
  return new NextResponse(body, { status: 200, headers: base })
}

// JSON response with an ETag over its body. `private, no-cache` makes the
// browser keep it but revalidate on every request: when nothing changed the
// server answers an empty 304 and the browser hands the app the copy it
// already has (transparent to axios). For the big lists every open page
// polls every 15s (Services, NetworkPolicies, layout), that's most polls on
// a large cluster carrying no body at all.
export async function jsonWithEtag(req: NextRequest | Request, data: unknown): Promise<NextResponse> {
  const body = JSON.stringify(data)
  const etag = `"${createHash('sha1').update(body).digest('base64url')}"`
  const headers = { ETag: etag, 'Cache-Control': 'private, no-cache' }
  if (req.headers.get('if-none-match') === etag) return new NextResponse(null, { status: 304, headers })
  return jsonBody(req, body, headers)
}
