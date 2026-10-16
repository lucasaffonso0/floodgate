import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { acceptsGzip, gzipBody, jsonBody } from '@/lib/api-helpers'
import { logAudit } from '@/lib/audit'
import { getDiscoveredFlowsSince, getDiscoveredFlowsSummary, clearDiscoveredFlows, isHubbleStreaming } from '@/lib/hubble'

// The full list can be tens of MB, so the client normally asks only for
// what changed: ?since=<version it holds> returns just the rows written
// after that version (getDiscoveredFlowsSince), or the full list flagged
// `full: true` when a delta can't be trusted (rows deleted since, restart).
// Same version as the one held: an empty 304. If-None-Match is still
// honored for plain full fetches. no-store keeps the browser's HTTP cache
// out of the way: the client keeps its own copy.
export async function GET(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user || user.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const version = getDiscoveredFlowsSummary().version
  const headers = { ETag: `"${version}"`, 'Cache-Control': 'no-store' }
  const since = req.nextUrl.searchParams.get('since')
  if (since === version || req.headers.get('if-none-match') === headers.ETag) return new NextResponse(null, { status: 304, headers })

  // A full list is the same for everyone at a given version (several
  // browsers loading at once, or catching up after a delete): built,
  // serialized and compressed once per version. Deltas are small and
  // per-client.
  const g = global as typeof global & { _floodgateFullFlowsCache?: { version: string; flows: string; gz?: Promise<Buffer> } }
  if (!since || since.split('.')[0] !== version.split('.')[0]) {
    if (g._floodgateFullFlowsCache?.version !== version) {
      g._floodgateFullFlowsCache = { version, flows: JSON.stringify(getDiscoveredFlowsSince(null).flows) }
    }
    const cache = g._floodgateFullFlowsCache
    const body = `{"available":true,"streaming":${isHubbleStreaming()},"full":true,"version":${JSON.stringify(version)},"flows":${cache.flows}}`
    // The streaming flag is part of the body, so the compressed copy is
    // only reused while it matches.
    if (acceptsGzip(req)) {
      const key = `${isHubbleStreaming()}`
      const c = cache as typeof cache & { gzKey?: string }
      if (!c.gz || c.gzKey !== key) { c.gz = gzipBody(body); c.gzKey = key }
      return jsonBody(req, body, headers, await c.gz)
    }
    return jsonBody(req, body, headers)
  }

  const result = getDiscoveredFlowsSince(since)
  return jsonBody(req, JSON.stringify({
    available: true,
    streaming: isHubbleStreaming(),
    full: result.full,
    version: result.version,
    flows: result.flows,
    removed: result.removed,
  }), { ...headers, ETag: `"${result.version}"` })
}

export async function DELETE() {
  const user = await getCurrentUser()
  if (!user || user.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // Irreversível e apaga todo o histórico da Descoberta: fica registrado
  // quem limpou e quanto foi apagado.
  const deleted = clearDiscoveredFlows()
  logAudit({
    user_id: user.sub,
    username: user.username,
    action: 'clear_discovered_flows',
    resource_type: 'Flows',
    details: JSON.stringify(deleted),
  })
  return new NextResponse(null, { status: 204 })
}
