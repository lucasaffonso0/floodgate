import { NextResponse } from 'next/server'
import { getCurrentUser } from '@/lib/auth'
import { refreshRepoInBackground } from '@/lib/git'
import { apiError } from '@/lib/api-helpers'

// Manual trigger for the same fetch+reset (+ commit-author map refresh)
// the scheduler already runs on its own every few minutes
// (GIT_BACKGROUND_REFRESH_MS, scheduler.ts) — an admin actively testing
// (make a commit outside floodgate, want to see it reflected right away)
// shouldn't have to wait out that whole interval. Read paths themselves
// stay network-free either way (git.ts's ensureRepoCloned) — this only
// updates what's on disk, which they read from.
export async function POST() {
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })
  if (user.role !== 'admin') return NextResponse.json({ detail: 'Forbidden' }, { status: 403 })
  try {
    const result = await refreshRepoInBackground()
    return NextResponse.json(result)
  } catch (e) {
    return apiError(e, 'Falha ao sincronizar com o repositório GitOps')
  }
}
