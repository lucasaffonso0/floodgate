import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser, canManageNamespace } from '@/lib/auth'
import { adoptPolicy, unadoptPolicy } from '@/lib/k8s'
import { saveManagedPolicy, removeManagedPolicy } from '@/lib/autosync'
import { logAudit } from '@/lib/audit'

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })

  const { namespace, name, policy_type } = await req.json()
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
    const msg = e instanceof Error ? e.message : String(e)
    const status = msg.includes('já é gerenciada') ? 409 : 500
    return NextResponse.json({ detail: msg }, { status })
  }
}

export async function DELETE(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })

  const { namespace, name } = await req.json()
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
    return NextResponse.json({ detail: String(e) }, { status: 500 })
  }
}
