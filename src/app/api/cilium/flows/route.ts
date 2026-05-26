import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { getDiscoveredFlows, clearDiscoveredFlows, isHubbleStreaming } from '@/lib/hubble'

export async function GET() {
  const user = await getCurrentUser()
  if (!user || user.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  return NextResponse.json({
    available: true,
    streaming: isHubbleStreaming(),
    flows: getDiscoveredFlows(),
  })
}

export async function DELETE() {
  const user = await getCurrentUser()
  if (!user || user.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  clearDiscoveredFlows()
  return new NextResponse(null, { status: 204 })
}
