import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { getDiscoveredFlowsSummary, isHubbleStreaming } from '@/lib/hubble'

// What the main page polls every cycle instead of the full flow list: the
// list's version (fetch the list only when it changed and something on
// screen needs it), streaming state and the Descoberta badge count.
export async function GET() {
  const user = await getCurrentUser()
  if (!user || user.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  return NextResponse.json(
    { ...getDiscoveredFlowsSummary(), streaming: isHubbleStreaming() },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
