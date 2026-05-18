import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { getConfig } from '@/lib/config'
import { runAutosync, checkDrift, getLastSyncResult, getManagedPolicyCount } from '@/lib/autosync'
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
    return NextResponse.json({ detail: String(e) }, { status: 500 })
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
    return NextResponse.json({ detail: String(e) }, { status: 500 })
  }
}
