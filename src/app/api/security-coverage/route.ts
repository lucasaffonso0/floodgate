import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { listServices, listNetworkPolicies } from '@/lib/k8s'
import { computeSecurityCoverage } from '@/lib/autoDefaultDeny'

// Read-only: the automatic default-deny that used to run from here (on the
// browser's poll, only while an admin had the page open) now runs in the
// scheduler (autoDefaultDeny.ts runAutoDefaultDeny).
export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })

  const [services, policies] = await Promise.all([listServices(), listNetworkPolicies()])
  return NextResponse.json(computeSecurityCoverage(services, policies))
}
