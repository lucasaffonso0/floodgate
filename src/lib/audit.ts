import 'server-only'
import { getDb } from './db'

export function logAudit(params: {
  user_id?: string
  username: string
  action: string
  resource_type?: string
  resource_name?: string
  namespace?: string
  details?: string
}) {
  try {
    getDb().prepare(`
      INSERT INTO audit_logs (user_id, username, action, resource_type, resource_name, namespace, details)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.user_id ?? '',
      params.username,
      params.action,
      params.resource_type ?? '',
      params.resource_name ?? '',
      params.namespace ?? '',
      params.details ?? '',
    )
  } catch { /* best-effort */ }
}
