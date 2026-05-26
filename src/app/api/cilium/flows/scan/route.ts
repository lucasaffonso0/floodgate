import { NextResponse } from 'next/server'

// Deprecated — streaming is now managed automatically by the scheduler
export async function POST() {
  return NextResponse.json({ error: 'Deprecated — use hubble_discovery_enabled config toggle' }, { status: 410 })
}
