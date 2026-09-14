import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { getConfig } from '@/lib/config'
import { runAutosync, checkDrift, getLastSyncResult, getManagedPolicyCount, removeManagedPolicy } from '@/lib/autosync'
import { apiError } from '@/lib/api-helpers'
import { logAudit } from '@/lib/audit'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })
  try {
    const cfg = getConfig()
    const drift = await checkDrift()
    return NextResponse.json({
      enabled: cfg.autosync_enabled,
      interval_s: cfg.autosync_interval_s,
      desired_count: getManagedPolicyCount(),
      drift,
      last_result: getLastSyncResult(),
    })
  } catch (e) {
    return apiError(e, 'Falha ao consultar status do autosync')
  }
}

export async function POST() {
  try {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })
    if (user.role !== 'admin') return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })

    const result = await runAutosync()

    if (result.fixed > 0) {
      logAudit({
        user_id: user.sub, username: user.username,
        action: 'autosync',
        resource_type: 'NetworkPolicy', resource_name: '', namespace: '',
        details: JSON.stringify({ checked: result.checked, fixed: result.fixed, drifted: result.drifted }),
      })
    }

    return NextResponse.json(result)
  } catch (e) {
    return apiError(e, 'Falha ao executar autosync')
  }
}

// Drops a managed_policies row whose target namespace no longer exists —
// autosync can never restore it, so it's an admin-initiated cleanup, not a
// cluster mutation (the K8s resource is already gone).
export async function DELETE(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })
    if (user.role !== 'admin') return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })

    const namespace = req.nextUrl.searchParams.get('namespace')
    const name = req.nextUrl.searchParams.get('name')
    if (!namespace || !name) return NextResponse.json({ detail: 'namespace e name são obrigatórios' }, { status: 400 })

    const drift = await checkDrift()
    const entry = drift.missing.find(m => m.namespace === namespace && m.name === name)
    if (!entry?.namespace_missing) {
      return NextResponse.json({ detail: 'Esta policy não está órfã (namespace ainda existe ou policy está ativa)' }, { status: 409 })
    }

    removeManagedPolicy(namespace, name)
    logAudit({
      user_id: user.sub, username: user.username,
      action: 'autosync_orphan_removed',
      resource_type: 'NetworkPolicy', resource_name: name, namespace,
      details: JSON.stringify({ reason: 'namespace_missing' }),
    })

    return NextResponse.json({ ok: true })
  } catch (e) {
    return apiError(e, 'Falha ao remover policy órfã')
  }
}
