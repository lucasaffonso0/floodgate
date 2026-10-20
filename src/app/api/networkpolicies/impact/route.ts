import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { apiError, parseBody } from '@/lib/api-helpers'
import { computeTrafficImpact } from '@/lib/trafficImpact'
import type { Draft } from '@/types'

const KINDS = new Set(['connection', 'isolate', 'restrict', 'toggle', 'remove'])
const MAX_DRAFTS = 500

// Read-only: what applying these changes (described like Modo Rascunho
// drafts) would block among the connections Descoberta has seen. Called by
// the UI right before applying an isolation, default-deny, companion
// removal or policy deletion outside Modo Rascunho, to ask for
// confirmation. Nothing is written.
export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })
  const body = await parseBody<{ drafts?: unknown }>(req)
  if (!body || !Array.isArray(body.drafts) || body.drafts.length === 0 || body.drafts.length > MAX_DRAFTS) {
    return NextResponse.json({ detail: `drafts deve ser uma lista com 1 a ${MAX_DRAFTS} itens` }, { status: 400 })
  }
  const drafts = body.drafts as Draft[]
  if (drafts.some(d => typeof d !== 'object' || d === null || !KINDS.has(d.kind ?? 'connection'))) {
    return NextResponse.json({ detail: 'tipo de rascunho inválido' }, { status: 400 })
  }
  try {
    return NextResponse.json(await computeTrafficImpact(drafts.map((d, i) => ({ ...d, id: d.id ?? `impact-${i}` }))))
  } catch (e) {
    return apiError(e, 'Falha ao calcular o impacto no tráfego')
  }
}
