import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { getConfig, setConfig } from '@/lib/config'
import { logAudit } from '@/lib/audit'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })
  return NextResponse.json(getConfig())
}

export async function PUT(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })
  if (user.role !== 'admin') return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })
  try {
    const body = await req.json()

    if (body.approval_required_count !== undefined) {
      if (!Number.isInteger(body.approval_required_count) || body.approval_required_count < 1 || body.approval_required_count > 100) {
        return NextResponse.json({ detail: 'approval_required_count deve ser um inteiro entre 1 e 100' }, { status: 400 })
      }
    }
    if (body.autosync_interval_s !== undefined) {
      if (!Number.isInteger(body.autosync_interval_s) || body.autosync_interval_s < 10) {
        return NextResponse.json({ detail: 'autosync_interval_s deve ser um inteiro >= 10' }, { status: 400 })
      }
    }
    if (body.auto_default_deny_direction !== undefined) {
      if (!['ingress', 'egress', 'both'].includes(body.auto_default_deny_direction)) {
        return NextResponse.json({ detail: "auto_default_deny_direction deve ser 'ingress', 'egress' ou 'both'" }, { status: 400 })
      }
    }
    if (body.watched_namespaces !== undefined && !Array.isArray(body.watched_namespaces)) {
      return NextResponse.json({ detail: 'watched_namespaces deve ser um array' }, { status: 400 })
    }
    if (body.ignored_namespaces !== undefined && !Array.isArray(body.ignored_namespaces)) {
      return NextResponse.json({ detail: 'ignored_namespaces deve ser um array' }, { status: 400 })
    }

    setConfig(body)
    logAudit({ user_id: user.sub, username: user.username, action: 'update_config', resource_type: 'Config', resource_name: 'app_config' })
    return NextResponse.json(getConfig())
  } catch (e) {
    return NextResponse.json({ detail: String(e) }, { status: 500 })
  }
}
