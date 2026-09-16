import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { getConfig, setConfig } from '@/lib/config'
import { apiError, parseBody } from '@/lib/api-helpers'
import { logAudit } from '@/lib/audit'
import { CronExpressionParser } from 'cron-parser'
import type { AppConfig } from '@/types'

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
    const body = await parseBody<Partial<AppConfig>>(req)
    if (!body) return NextResponse.json({ detail: 'Body JSON inválido' }, { status: 400 })

    for (const key of ['approval_enabled', 'auto_default_deny_enabled', 'autosync_enabled', 'hubble_discovery_enabled', 'backup_enabled'] as const) {
      if (body[key] !== undefined && typeof body[key] !== 'boolean') {
        return NextResponse.json({ detail: `${key} deve ser booleano` }, { status: 400 })
      }
    }
    for (const key of ['watched_namespaces', 'ignored_namespaces'] as const) {
      if (Array.isArray(body[key]) && (body[key] as unknown[]).some(v => typeof v !== 'string')) {
        return NextResponse.json({ detail: `${key} deve conter apenas strings` }, { status: 400 })
      }
    }
    if (body.hubble_flow_retention_days !== undefined) {
      if (!Number.isInteger(body.hubble_flow_retention_days) || (body.hubble_flow_retention_days as number) < 1) {
        return NextResponse.json({ detail: 'hubble_flow_retention_days deve ser um inteiro >= 1' }, { status: 400 })
      }
    }
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
    if (body.backup_cron !== undefined) {
      try {
        CronExpressionParser.parse(body.backup_cron)
      } catch (e) {
        return NextResponse.json({ detail: `backup_cron inválido: ${e instanceof Error ? e.message : String(e)}` }, { status: 400 })
      }
    }
    if (body.backup_s3_bucket !== undefined && typeof body.backup_s3_bucket !== 'string') {
      return NextResponse.json({ detail: 'backup_s3_bucket deve ser uma string' }, { status: 400 })
    }
    if (body.backup_s3_prefix !== undefined && typeof body.backup_s3_prefix !== 'string') {
      return NextResponse.json({ detail: 'backup_s3_prefix deve ser uma string' }, { status: 400 })
    }

    // Merge over the current config so partial updates don't write `undefined`
    setConfig({ ...getConfig(), ...body })
    logAudit({ user_id: user.sub, username: user.username, action: 'update_config', resource_type: 'Config', resource_name: 'app_config' })
    return NextResponse.json(getConfig())
  } catch (e) {
    return apiError(e, 'Falha ao salvar configuração')
  }
}
