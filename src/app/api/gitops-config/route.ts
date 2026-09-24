import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { getGitOpsConfig, setGitOpsConnection, type GitOpsConnectionUpdate } from '@/lib/gitopsConfig'
import { testGitOpsConnection } from '@/lib/git'
import { apiError, parseBody } from '@/lib/api-helpers'
import { logAudit } from '@/lib/audit'

// Admin-only both ways (unlike GET /api/backup, which any authenticated
// user can read) — this exposes the GitOps repo URL/branch, infra detail
// the plan scopes to admins only. The SSH private key never appears in
// either direction: getGitOpsConfig() (GET) only ever returns
// credentials_configured, and a PUT accepts a new key but the response
// still only echoes back the safe view.
export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })
  if (user.role !== 'admin') return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })
  try {
    return NextResponse.json(getGitOpsConfig())
  } catch (e) {
    return apiError(e, 'Falha ao consultar configuração do GitOps')
  }
}

export async function PUT(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })
  if (user.role !== 'admin') return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })

  const body = await parseBody<GitOpsConnectionUpdate>(req)
  if (!body) return NextResponse.json({ detail: 'Body JSON inválido' }, { status: 400 })

  try {
    setGitOpsConnection(body)
    logAudit({
      user_id: user.sub, username: user.username,
      action: 'update_gitops_config',
      resource_type: 'GitOpsConfig', resource_name: '', namespace: '',
      // Never log the key/known_hosts content itself — only which fields changed.
      details: JSON.stringify({ fields_updated: Object.keys(body) }),
    })
    // Test the connection right away (clone-on-first-use, or fetch+reset if
    // already cloned) so a bad URL/branch/key surfaces here, in the panel,
    // instead of silently failing the next time someone tries to create a
    // policy. Never fails the save itself — the config is already
    // persisted above; this only reports whether it currently works.
    const connectionTest = await testGitOpsConnection()
    return NextResponse.json({ ...getGitOpsConfig(), connection_test: connectionTest })
  } catch (e) {
    return apiError(e, 'Falha ao salvar configuração do GitOps')
  }
}
