import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { getDiscoveredFlows, getDiscoveredFlowsSummary } from '@/lib/hubble'
import { aggregateFlowEdges } from '@/lib/flowEdges'
import { acceptsGzip, gzipBody, jsonBody } from '@/lib/api-helpers'

// What the graph needs from the flow list, already collapsed to one entry
// per edge (aggregateFlowEdges): hundreds of entries instead of tens of
// thousands of rows, for when "Tráfego ao vivo" is on but the Descoberta
// list (which needs every row) isn't open. Same version/ETag as the full
// list: an unchanged poll gets an empty 304.
export async function GET(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user || user.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const version = getDiscoveredFlowsSummary().version
  const headers = { ETag: `"${version}"`, 'Cache-Control': 'no-store' }
  if (req.headers.get('if-none-match') === headers.ETag) return new NextResponse(null, { status: 304, headers })

  // Every open graph asks for the same version at about the same time:
  // build (read every row, aggregate, serialize, compress) once per version.
  const g = global as typeof global & { _floodgateEdgesCache?: { version: string; body: string; gz?: Promise<Buffer> } }
  if (g._floodgateEdgesCache?.version !== version) {
    g._floodgateEdgesCache = { version, body: JSON.stringify({ version, edges: aggregateFlowEdges(getDiscoveredFlows()) }) }
  }
  const cache = g._floodgateEdgesCache
  if (acceptsGzip(req)) {
    cache.gz ??= gzipBody(cache.body)
    return jsonBody(req, cache.body, headers, await cache.gz)
  }
  return jsonBody(req, cache.body, headers)
}
