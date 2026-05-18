import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { exportManagedPoliciesYAML } from '@/lib/k8s'

export async function GET() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })
  if (user.role === 'viewer' || user.role === 'audit') {
    return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })
  }
  try {
    const yaml = await exportManagedPoliciesYAML()
    return new NextResponse(yaml, {
      headers: {
        'Content-Type': 'text/yaml; charset=utf-8',
        'Content-Disposition': 'attachment; filename="floodgate-policies.yaml"',
      },
    })
  } catch (e) {
    return NextResponse.json({ detail: String(e) }, { status: 500 })
  }
}
