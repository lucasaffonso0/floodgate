import { NextResponse } from 'next/server'
import { listServices } from '@/lib/k8s'
import { isNamespaceWatched } from '@/lib/config'
import '@/lib/scheduler'

const SELF_NAMESPACE = 'floodgate'

export async function GET() {
  try {
    const svcs = await listServices()
    return NextResponse.json(
      svcs.filter(s => s.namespace !== SELF_NAMESPACE && isNamespaceWatched(s.namespace))
    )
  } catch (e) {
    return NextResponse.json({ detail: String(e) }, { status: 500 })
  }
}
