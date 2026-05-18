import 'server-only'
import { SignJWT, jwtVerify } from 'jose'
import bcrypt from 'bcryptjs'
import { cookies } from 'next/headers'
import { getDb } from './db'

if (process.env.NODE_ENV === 'production' &&
    process.env.NEXT_PHASE !== 'phase-production-build' &&
    (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'floodgate-secret-change-me')) {
  throw new Error('[floodgate] JWT_SECRET não definido ou usando valor padrão inseguro. Defina JWT_SECRET no ambiente.')
}

const SECRET = new TextEncoder().encode(process.env.JWT_SECRET ?? 'floodgate-secret-change-me')
export const COOKIE = 'floodgate-token'

export interface JWTPayload {
  sub: string
  username: string
  role: 'admin' | 'ns_admin' | 'viewer' | 'audit'
  has_ns_permissions: boolean
  token_version: number
  must_change_password: boolean
}

export async function signToken(payload: JWTPayload): Promise<string> {
  return new SignJWT({
    username: payload.username,
    role: payload.role,
    has_ns_permissions: payload.has_ns_permissions,
    token_version: payload.token_version,
    must_change_password: payload.must_change_password,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime('24h')
    .sign(SECRET)
}

export async function verifyToken(token: string): Promise<JWTPayload | null> {
  try {
    const { payload } = await jwtVerify(token, SECRET)
    return {
      sub: payload.sub as string,
      username: payload.username as string,
      role: payload.role as JWTPayload['role'],
      has_ns_permissions: (payload.has_ns_permissions as boolean) ?? false,
      token_version: (payload.token_version as number) ?? 1,
      must_change_password: (payload.must_change_password as boolean) ?? false,
    }
  } catch {
    return null
  }
}

export async function getCurrentUser(): Promise<JWTPayload & { allowed_namespaces: string[] } | null> {
  const store = await cookies()
  const token = store.get(COOKIE)?.value
  if (!token) return null
  const payload = await verifyToken(token)
  if (!payload) return null

  const db = getDb()
  const user = db.prepare('SELECT username, role, token_version, must_change_password FROM users WHERE id = ?').get(payload.sub) as
    | { username: string; role: JWTPayload['role']; token_version: number; must_change_password: number }
    | undefined
  if (!user) return null
  if ((user.token_version ?? 1) !== (payload.token_version ?? 1)) return null

  const perms = db
    .prepare('SELECT namespace FROM namespace_permissions WHERE user_id = ?')
    .all(payload.sub) as { namespace: string }[]
  const allowedNamespaces = perms.map(p => p.namespace)

  return {
    sub: payload.sub,
    username: user.username,
    role: user.role,
    has_ns_permissions: allowedNamespaces.length > 0,
    token_version: user.token_version ?? 1,
    must_change_password: user.must_change_password === 1,
    allowed_namespaces: allowedNamespaces,
  }
}

export async function canManageNamespace(userId: string, role: string, namespace: string): Promise<boolean> {
  if (role === 'admin') return true
  const perm = getDb()
    .prepare('SELECT id FROM namespace_permissions WHERE user_id = ? AND namespace = ?')
    .get(userId, namespace)
  return !!perm
}

// Pre-computed hash used only when the username doesn't exist — ensures bcrypt always runs
// to prevent user enumeration via response timing differences.
const DUMMY_HASH = '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy'

export async function login(username: string, password: string): Promise<string | null> {
  const db = getDb()
  const user = db.prepare('SELECT id, password_hash, role, token_version, must_change_password FROM users WHERE username = ?').get(username) as
    | { id: string; password_hash: string; role: string; token_version: number; must_change_password: number }
    | undefined
  const passwordMatch = bcrypt.compareSync(password, user?.password_hash ?? DUMMY_HASH)
  if (!user || !passwordMatch) return null
  const perms = db.prepare('SELECT namespace FROM namespace_permissions WHERE user_id = ?').all(user.id) as { namespace: string }[]
  const has_ns_permissions = perms.length > 0
  return signToken({
    sub: user.id,
    username,
    role: user.role as JWTPayload['role'],
    has_ns_permissions,
    token_version: user.token_version ?? 1,
    must_change_password: user.must_change_password === 1,
  })
}
