import { NextRequest, NextResponse } from 'next/server'
import { listServices } from '@/lib/k8s'
import { getCurrentUser } from '@/lib/auth'
import { namespaceWatchFilter } from '@/lib/config'
import { apiError, jsonWithEtag } from '@/lib/api-helpers'
import '@/lib/scheduler'

const SELF_NAMESPACE = 'floodgate'

export async function GET(req: NextRequest) {
  // getCurrentUser revalidates token_version against the DB: the middleware
  // only verifies the JWT signature, so revoked sessions would pass it.
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })
  try {
    const svcs = await listServices()
    const watched = namespaceWatchFilter()
    return jsonWithEtag(req, svcs.filter(s => s.namespace !== SELF_NAMESPACE && watched(s.namespace)))
  } catch (e) {
    return apiError(e, 'Falha ao listar services')
  }
}
