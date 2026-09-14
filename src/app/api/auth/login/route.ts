import { NextRequest, NextResponse } from 'next/server'
import { login, COOKIE } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { checkRateLimit, checkIpRateLimit, clearRateLimit } from '@/lib/ratelimit'

export async function POST(req: NextRequest) {
  try {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0].trim()
      ?? req.headers.get('x-real-ip')
      ?? 'unknown'
    const ipRl = checkIpRateLimit(ip)
    if (!ipRl.allowed) {
      const retryAfterS = Math.ceil((ipRl.retryAfterMs ?? 0) / 1000)
      return NextResponse.json(
        { detail: 'Muitas tentativas. Tente novamente mais tarde.' },
        { status: 429, headers: { 'Retry-After': String(retryAfterS) } },
      )
    }

    const { username, password } = await req.json()
    const rlKey = `login:${(username ?? '').toLowerCase()}`
    const rl = checkRateLimit(rlKey)
    if (!rl.allowed) {
      const retryAfterS = Math.ceil((rl.retryAfterMs ?? 0) / 1000)
      return NextResponse.json(
        { detail: 'Muitas tentativas. Tente novamente mais tarde.' },
        { status: 429, headers: { 'Retry-After': String(retryAfterS) } },
      )
    }

    const token = await login(username, password)
    if (!token) {
      logAudit({ user_id: '', username: username ?? '', action: 'login_failed', resource_type: 'User', resource_name: username ?? '' })
      return NextResponse.json({ detail: 'Credenciais inválidas' }, { status: 401 })
    }

    clearRateLimit(rlKey)
    logAudit({ user_id: '', username: username ?? '', action: 'login_success', resource_type: 'User', resource_name: username ?? '' })
    const res = NextResponse.json({ ok: true })
    res.cookies.set(COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: 86400,
      path: '/',
      secure: process.env.NODE_ENV === 'production',
    })
    return res
  } catch (e) {
    console.error('[floodgate] login error:', e)
    return NextResponse.json({ detail: 'Erro interno. Tente novamente.' }, { status: 500 })
  }
}
