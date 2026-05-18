import { NextResponse } from 'next/server'
import '@/lib/scheduler'

export async function GET() {
  return NextResponse.json({ ok: true })
}
