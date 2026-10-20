import { NextRequest, NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { listWorkloadKeys } from '@/lib/k8s'
import { apiError, jsonWithEtag } from '@/lib/api-helpers'

// Workloads that currently have pods ("namespace/name"), so the Policies tab
// can tell a policy whose source is a Service-less workload (still running)
// from one whose source is really gone. A workload scaled to zero has no
// pods and isn't listed.
export async function GET(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })
  try {
    return jsonWithEtag(req, await listWorkloadKeys())
  } catch (e) {
    return apiError(e, 'Falha ao listar workloads')
  }
}
