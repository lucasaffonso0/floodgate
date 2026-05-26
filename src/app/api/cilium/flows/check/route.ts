import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { checkHubbleAvailable } from '@/lib/hubble'

export async function GET() {
  const user = await getCurrentUser()
  if (!user || user.role !== 'admin') return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const available = await checkHubbleAvailable()
  return NextResponse.json({ available })
}
