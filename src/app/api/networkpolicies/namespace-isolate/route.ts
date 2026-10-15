import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser, canManageNamespace } from '@/lib/auth'
import { isolateNamespace, isolateNamespaces } from '@/lib/k8s'
import { isNamespaceWatched } from '@/lib/config'
import { apiError, parseBody } from '@/lib/api-helpers'
import { logAudit } from '@/lib/audit'
import { trackIsolatedPolicies } from '@/lib/autosync'
import { emit } from '@/lib/sse'

type IsolateItem = { namespace?: string; direction?: string; allow_intra_namespace?: boolean; allow_egress_internet?: boolean }
type ValidItem = { namespace: string; direction: 'ingress' | 'egress' | 'both'; allow_intra_namespace: boolean; allow_egress_internet: boolean }

const MAX_BATCH = 500

// Returns the validated item, or the response explaining why it's rejected.
async function validateItem(item: IsolateItem, user: { sub: string; role: string }): Promise<ValidItem | NextResponse> {
  const { namespace, direction } = item
  if (!namespace || !direction) {
    return NextResponse.json({ detail: 'namespace e direction são obrigatórios' }, { status: 400 })
  }
  if (!['ingress', 'egress', 'both'].includes(direction)) {
    return NextResponse.json({ detail: "direction deve ser 'ingress', 'egress' ou 'both'" }, { status: 400 })
  }
  if (!isNamespaceWatched(namespace)) {
    return NextResponse.json({ detail: `Namespace ${namespace} fora do escopo gerenciado pelo floodgate` }, { status: 400 })
  }
  if (!await canManageNamespace(user.sub, user.role, namespace)) {
    return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })
  }
  return {
    namespace,
    direction: direction as ValidItem['direction'],
    allow_intra_namespace: !!item.allow_intra_namespace,
    allow_egress_internet: !!item.allow_egress_internet,
  }
}

function afterIsolate(item: ValidItem, user: { sub: string; username: string }, result: { created: number; skipped: number }) {
  // Save each created policy to managed_policies for autosync tracking.
  const dirs: ('ingress' | 'egress')[] = item.direction === 'both' ? ['ingress', 'egress'] : [item.direction]
  for (const dir of dirs) {
    trackIsolatedPolicies(item.namespace, dir, item.allow_intra_namespace, item.allow_egress_internet)
  }
  logAudit({
    user_id: user.sub,
    username: user.username,
    action: 'namespace_isolate',
    resource_type: 'NetworkPolicy',
    resource_name: item.namespace,
    namespace: item.namespace,
    details: JSON.stringify({ direction: item.direction, allow_intra_namespace: item.allow_intra_namespace, allow_egress_internet: item.allow_egress_internet, ...result }),
  })
}

// Body: one namespace ({ namespace, direction, ... }) or several at once
// ({ items: [...] }, the bulk actions in Segurança). Every item is checked
// (scope and permission) before anything is written; in GitOps mode the
// whole batch is one commit.
export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })

  const body = await parseBody<IsolateItem & { items?: IsolateItem[] }>(req)
  if (!body) return NextResponse.json({ detail: 'Body JSON inválido' }, { status: 400 })

  if (Array.isArray(body.items)) {
    if (body.items.length === 0) return NextResponse.json({ results: [] })
    if (body.items.length > MAX_BATCH) return NextResponse.json({ detail: `No máximo ${MAX_BATCH} namespaces por chamada` }, { status: 400 })
    const items: ValidItem[] = []
    for (const raw of body.items) {
      const v = await validateItem(raw, user)
      if (v instanceof NextResponse) return v
      items.push(v)
    }
    try {
      const results = await isolateNamespaces(items)
      results.forEach((r, i) => { if (!r.error) afterIsolate(items[i], user, r) })
      emit({ type: 'policy_created' })
      return NextResponse.json({ results }, { status: 201 })
    } catch (e) {
      return apiError(e, 'Falha ao isolar namespaces')
    }
  }

  const item = await validateItem(body, user)
  if (item instanceof NextResponse) return item
  try {
    const result = await isolateNamespace(item)
    afterIsolate(item, user, result)
    emit({ type: 'policy_created' })
    return NextResponse.json(result, { status: 201 })
  } catch (e) {
    return apiError(e, 'Falha ao isolar namespace')
  }
}
