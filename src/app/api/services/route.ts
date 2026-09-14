import { NextResponse } from 'next/server'
import { listServices } from '@/lib/k8s'
import { getCurrentUser } from '@/lib/auth'
import { isNamespaceWatched } from '@/lib/config'
import { apiError } from '@/lib/api-helpers'
import '@/lib/scheduler'

const SELF_NAMESPACE = 'floodgate'

export async function GET() {
  // getCurrentUser revalidates token_version against the DB — the middleware
  // only verifies the JWT signature, so revoked sessions would pass it.
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })
  try {
    const svcs = await listServices()
    return NextResponse.json(
      svcs.filter(s => s.namespace !== SELF_NAMESPACE && isNamespaceWatched(s.namespace))
    )
  } catch (e) {
    return apiError(e, 'Falha ao listar services')
  }
}
