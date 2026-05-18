import { NextRequest, NextResponse } from 'next/server'
import { createRestrictPolicy, getPolicyYAML } from '@/lib/k8s'
import { getCurrentUser, canManageNamespace } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { saveManagedPolicy } from '@/lib/autosync'
import { emit } from '@/lib/sse'

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })
  const body = await req.json()
  if (!(await canManageNamespace(user.sub, user.role, body.namespace))) {
    return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })
  }
  try {
    const result = await createRestrictPolicy(body)
    logAudit({ user_id: user.sub, username: user.username, action: 'create_policy', resource_type: 'NetworkPolicy', resource_name: result.name, namespace: result.namespace })
    getPolicyYAML(result.namespace, result.name).then(y => saveManagedPolicy(result.namespace, result.name, y)).catch(() => {})
    emit({ type: 'policy_created' })
    return NextResponse.json(result, { status: 201 })
  } catch (e) {
    return NextResponse.json({ detail: String(e) }, { status: 500 })
  }
}
