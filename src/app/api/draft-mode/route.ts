import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { getConfig } from '@/lib/config'
import { snapshotFlowsForDraftMode, getDraftModeFlows, clearDraftModeFlows, isDraftModeActive, setDraftModeActive } from '@/lib/hubble'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  return NextResponse.json({
    active: isDraftModeActive(),
    flows: isDraftModeActive() ? getDraftModeFlows() : [],
  })
}

export async function POST() {
  const user = await getCurrentUser()
  if (!user || user.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  if (!getConfig().hubble_discovery_enabled) {
    return NextResponse.json({ detail: 'Ative a Descoberta antes de ligar o Modo Rascunho' }, { status: 400 })
  }

  snapshotFlowsForDraftMode()
  setDraftModeActive(true)
  return NextResponse.json({ active: true, flows: getDraftModeFlows() })
}

export async function DELETE() {
  const user = await getCurrentUser()
  if (!user || user.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  clearDraftModeFlows()
  setDraftModeActive(false)
  return new NextResponse(null, { status: 204 })
}
