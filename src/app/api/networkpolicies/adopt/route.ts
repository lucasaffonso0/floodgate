import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser, canManageNamespace } from '@/lib/auth'
import { adoptPolicy, unadoptPolicy } from '@/lib/k8s'
import { apiError, parseBody } from '@/lib/api-helpers'
import { saveManagedPolicy, removeManagedPolicy } from '@/lib/autosync'
import { logAudit } from '@/lib/audit'

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })

  const body = await parseBody<{ namespace?: string; name?: string; policy_type?: string }>(req)
  if (!body) return NextResponse.json({ detail: 'Body JSON inválido' }, { status: 400 })
  const { namespace, name, policy_type } = body
  if (!namespace || !name) return NextResponse.json({ detail: 'namespace e name são obrigatórios' }, { status: 400 })
  if (!(await canManageNamespace(user.sub, user.role, namespace))) {
    return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })
  }

  try {
    const policyYaml = await adoptPolicy(namespace, name, policy_type)
    saveManagedPolicy(namespace, name, policyYaml)
    logAudit({
      user_id: user.sub, username: user.username,
      action: 'adopt_policy', resource_type: 'NetworkPolicy',
      resource_name: name, namespace,
    })
    return NextResponse.json({ ok: true, namespace, name })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : ''
    if (msg.includes('já é gerenciada')) return NextResponse.json({ detail: msg }, { status: 409 })
    return apiError(e, 'Falha ao adotar policy')
  }
}

export async function DELETE(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })

  const body = await parseBody<{ namespace?: string; name?: string }>(req)
  if (!body) return NextResponse.json({ detail: 'Body JSON inválido' }, { status: 400 })
  const { namespace, name } = body
  if (!namespace || !name) return NextResponse.json({ detail: 'namespace e name são obrigatórios' }, { status: 400 })
  if (!(await canManageNamespace(user.sub, user.role, namespace))) {
    return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })
  }

  try {
    await unadoptPolicy(namespace, name)
    removeManagedPolicy(namespace, name)
    logAudit({
      user_id: user.sub, username: user.username,
      action: 'unadopt_policy', resource_type: 'NetworkPolicy',
      resource_name: name, namespace,
    })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return apiError(e, 'Falha ao remover adoção da policy')
  }
}
