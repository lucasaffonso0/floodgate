import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { getDiscoveredFlows, getDiscoveredFlowsSummary, clearDiscoveredFlows, isHubbleStreaming } from '@/lib/hubble'

// The full list can be tens of MB. Its ETag is the cheap summary version
// (getDiscoveredFlowsSummary), checked BEFORE building the list, so an
// unchanged poll costs one aggregate query and an empty 304 instead of
// serializing every row. no-store keeps the browser's HTTP cache out of the
// way: the client sends If-None-Match itself and keeps its own copy, so a
// 304 reaches the app as "nothing changed" rather than as a re-parsed body.
export async function GET(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user || user.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const etag = `"${getDiscoveredFlowsSummary().version}"`
  const headers = { ETag: etag, 'Cache-Control': 'no-store' }
  if (req.headers.get('if-none-match') === etag) return new NextResponse(null, { status: 304, headers })

  return NextResponse.json({
    available: true,
    streaming: isHubbleStreaming(),
    flows: getDiscoveredFlows(),
  }, { headers })
}

export async function DELETE() {
  const user = await getCurrentUser()
  if (!user || user.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  clearDiscoveredFlows()
  return new NextResponse(null, { status: 204 })
}
