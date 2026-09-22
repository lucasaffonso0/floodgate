import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { previewPolicyYAML } from '@/lib/k8s'
import { apiError, parseBody } from '@/lib/api-helpers'
import type { CreatePolicyRequest } from '@/types'

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await parseBody<CreatePolicyRequest & { direction?: 'ingress' | 'egress' | 'both'; dst_cidr?: string; cidr_except?: string[] }>(req)
  if (!body) return NextResponse.json({ detail: 'Body JSON inválido' }, { status: 400 })
  const direction = body.direction ?? 'ingress'
  try {
    const yaml = await previewPolicyYAML(body, direction)
    return new NextResponse(yaml, { headers: { 'Content-Type': 'text/plain' } })
  } catch (e: unknown) {
    return apiError(e, 'Falha ao gerar preview', 400)
  }
}
