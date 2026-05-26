import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { previewPolicyYAML } from '@/lib/k8s'
import type { CreatePolicyRequest } from '@/types'

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body: CreatePolicyRequest & { direction?: 'ingress' | 'egress' | 'both' } = await req.json()
  const direction = body.direction ?? 'ingress'
  try {
    const yaml = await previewPolicyYAML(body, direction)
    return new NextResponse(yaml, { headers: { 'Content-Type': 'text/plain' } })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 400 })
  }
}
