import { NextRequest, NextResponse } from 'next/server'
import yaml from 'js-yaml'
import { getCurrentUser, canManageNamespace } from '@/lib/auth'
import { isNamespaceWatched } from '@/lib/config'
import { applyPolicyYAML } from '@/lib/k8s'
import { saveManagedPolicy } from '@/lib/autosync'
import { apiError, parseBody } from '@/lib/api-helpers'
import { logAudit } from '@/lib/audit'
import { emit } from '@/lib/sse'

type NetworkPolicyDoc = {
  kind?: string
  metadata?: { name?: string; namespace?: string }
}

// Counterpart to GET .../export: applies a multi-document YAML file (in the
// same shape export produces) back onto the cluster. Each document is
// created or replaced (applyPolicyYAML already handles the 409-then-replace
// case) and tracked in managed_policies, same as a normal create.
export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })
    if (user.role !== 'admin' && user.role !== 'ns_admin') {
      return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })
    }

    const body = await parseBody<{ yaml?: string }>(req)
    if (!body?.yaml) return NextResponse.json({ detail: 'yaml é obrigatório' }, { status: 400 })

    let docs: unknown[]
    try {
      docs = yaml.loadAll(body.yaml).filter((d): d is NetworkPolicyDoc => !!d)
    } catch (e) {
      return NextResponse.json({ detail: `YAML inválido: ${e instanceof Error ? e.message : String(e)}` }, { status: 400 })
    }

    let imported = 0
    const failures: string[] = []
    for (const doc of docs as NetworkPolicyDoc[]) {
      const ns = doc.metadata?.namespace
      const name = doc.metadata?.name
      const label = ns && name ? `${ns}/${name}` : '(documento sem namespace/nome)'
      if (doc.kind !== 'NetworkPolicy' || !ns || !name) {
        failures.push(`${label}: não é um NetworkPolicy válido`)
        continue
      }
      if (!isNamespaceWatched(ns)) {
        failures.push(`${label}: namespace fora do escopo gerenciado pelo floodgate`)
        continue
      }
      if (!(await canManageNamespace(user.sub, user.role, ns))) {
        failures.push(`${label}: sem permissão para gerenciar esse namespace`)
        continue
      }
      try {
        const docYaml = yaml.dump(doc)
        await applyPolicyYAML(ns, docYaml)
        saveManagedPolicy(ns, name, docYaml)
        imported++
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        console.error(`[floodgate] failed to import policy ${label}:`, msg)
        failures.push(`${label}: ${msg}`)
      }
    }

    logAudit({ user_id: user.sub, username: user.username, action: 'import_policies', details: `${imported} imported, ${failures.length} failed` })
    emit({ type: 'policy_created' })
    return NextResponse.json({ imported, failed: failures.length, failures })
  } catch (e) {
    return apiError(e, 'Falha ao importar policies')
  }
}
