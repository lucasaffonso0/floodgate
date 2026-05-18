import { NextRequest, NextResponse } from 'next/server'
import { jwtVerify } from 'jose'

const SECRET = new TextEncoder().encode(process.env.JWT_SECRET ?? 'floodgate-secret-change-me')
const COOKIE = 'floodgate-token'
const PUBLIC = ['/login', '/api/auth/login', '/api/auth/logout', '/api/health']

// Routes allowed even when must_change_password = true
const CHANGE_PW_ALLOWED_API = ['/api/auth/me', '/api/auth/logout']

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl

  if (PUBLIC.some(p => pathname.startsWith(p))) return NextResponse.next()

  const token = req.cookies.get(COOKIE)?.value
  if (!token) {
    if (pathname.startsWith('/api/')) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })
    return NextResponse.redirect(new URL('/login', req.url))
  }

  try {
    const { payload } = await jwtVerify(token, SECRET)

    // Force password change: block everything except own password PATCH and auth endpoints
    if (payload.must_change_password) {
      const isOwnPatch = pathname.match(/^\/api\/users\/[^/]+$/) && req.method === 'PATCH'
      const isAllowed = CHANGE_PW_ALLOWED_API.some(p => pathname.startsWith(p)) || isOwnPatch
      if (pathname.startsWith('/api/') && !isAllowed) {
        return NextResponse.json(
          { detail: 'Troca de senha obrigatória antes de continuar.', must_change_password: true },
          { status: 403 }
        )
      }
      // Page requests pass through — frontend shows the forced modal
    }

    return NextResponse.next()
  } catch {
    if (pathname.startsWith('/api/')) return NextResponse.json({ detail: 'Unauthorized' }, { status: 401 })
    const res = NextResponse.redirect(new URL('/login', req.url))
    res.cookies.delete(COOKIE)
    return res
  }
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
