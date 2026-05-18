'use client'

import { useState, useEffect, useCallback } from 'react'
import { getAuditLogs } from '@/api/client'
import type { AuditLog } from '@/types'

const ACTION_COLORS: Record<string, { bg: string; color: string }> = {
  create_policy:              { bg: '#f0fdf4', color: '#16a34a' },
  delete_policy:              { bg: '#fef2f2', color: '#dc2626' },
  update_policy_port:         { bg: '#eff6ff', color: '#2563eb' },
  create_approval_request:    { bg: '#fefce8', color: '#ca8a04' },
  approve_vote:               { bg: '#f0fdf4', color: '#16a34a' },
  reject_approval_request:    { bg: '#fef2f2', color: '#dc2626' },
  apply_approval_request:     { bg: '#f0fdf4', color: '#16a34a' },
  cancel_approval_request:    { bg: '#f8fafc', color: '#64748b' },
  grant_namespace_permission: { bg: '#f5f3ff', color: '#7c3aed' },
  revoke_namespace_permission:{ bg: '#fff7ed', color: '#c2410c' },
  auto_default_deny_ingress:  { bg: '#fff7ed', color: '#c2410c' },
  auto_default_deny_egress:   { bg: '#fff7ed', color: '#c2410c' },
  apply_default_deny_ingress: { bg: '#fff7ed', color: '#c2410c' },
  apply_default_deny_egress:  { bg: '#fff7ed', color: '#c2410c' },
}

function ActionBadge({ action }: { action: string }) {
  const s = ACTION_COLORS[action] ?? { bg: '#f8fafc', color: '#64748b' }
  const label = action.replace(/_/g, ' ')
  return (
    <span style={{ fontSize: 10, fontWeight: 700, background: s.bg, color: s.color, borderRadius: 4, padding: '2px 6px', border: `1px solid ${s.color}33`, whiteSpace: 'nowrap' }}>
      {label}
    </span>
  )
}

function escapeCSV(val: unknown): string {
  const s = val == null ? '' : String(val)
  return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s
}

export default function AuditPage() {
  const [logs, setLogs] = useState<AuditLog[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [offset, setOffset] = useState(0)
  const [nsFilter, setNsFilter] = useState('')
  const [actionFilter, setActionFilter] = useState('')
  const LIMIT = 50

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const { logs: l, total: t } = await getAuditLogs({ limit: LIMIT, offset, namespace: nsFilter || undefined, action: actionFilter || undefined })
      setLogs(l)
      setTotal(t)
    } finally {
      setLoading(false)
    }
  }, [offset, nsFilter, actionFilter])

  const exportAll = useCallback(async (format: 'csv' | 'json') => {
    setExporting(true)
    try {
      const { logs: all } = await getAuditLogs({ limit: 10000, offset: 0, namespace: nsFilter || undefined, action: actionFilter || undefined })
      const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      const filename = `audit-${ts}${nsFilter ? `-${nsFilter}` : ''}${actionFilter ? `-${actionFilter}` : ''}.${format}`

      let content: string
      if (format === 'json') {
        content = JSON.stringify(all, null, 2)
      } else {
        const headers = ['id', 'created_at', 'username', 'action', 'resource_type', 'resource_name', 'namespace', 'details']
        const rows = all.map(l => headers.map(h => escapeCSV(l[h as keyof AuditLog])).join(','))
        content = [headers.join(','), ...rows].join('\n')
      }

      const blob = new Blob([content], { type: format === 'json' ? 'application/json' : 'text/csv' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = filename; a.click()
      URL.revokeObjectURL(url)
    } finally {
      setExporting(false)
    }
  }, [nsFilter, actionFilter])

  useEffect(() => { load() }, [load])

  const filtered = logs

  const cell: React.CSSProperties = { padding: '10px 14px', fontSize: 12, color: '#374151', borderBottom: '1px solid #f1f5f9', verticalAlign: 'middle' }

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc' }}>
      <header style={{ background: 'white', borderBottom: '1px solid #e2e8f0', padding: '0 24px', height: 56, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <a href="/" style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#64748b', fontSize: 13, textDecoration: 'none', fontWeight: 500 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
            Voltar ao painel
          </a>
          <span style={{ color: '#e2e8f0' }}>|</span>
          <span style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>Audit Log</span>
          <span style={{ fontSize: 12, color: '#94a3b8' }}>{total} evento(s) registrado(s)</span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => exportAll('csv')}
            disabled={exporting}
            title="Exportar todos os logs filtrados como CSV"
            style={{ display: 'flex', alignItems: 'center', gap: 5, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 6, padding: '6px 12px', fontSize: 12, color: '#16a34a', cursor: exporting ? 'not-allowed' : 'pointer', fontWeight: 600, opacity: exporting ? 0.6 : 1 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            CSV
          </button>
          <button
            onClick={() => exportAll('json')}
            disabled={exporting}
            title="Exportar todos os logs filtrados como JSON"
            style={{ display: 'flex', alignItems: 'center', gap: 5, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, padding: '6px 12px', fontSize: 12, color: '#2563eb', cursor: exporting ? 'not-allowed' : 'pointer', fontWeight: 600, opacity: exporting ? 0.6 : 1 }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            JSON
          </button>
          <button onClick={load} style={{ background: '#f1f5f9', border: 'none', borderRadius: 6, padding: '6px 14px', fontSize: 12, color: '#475569', cursor: 'pointer', fontWeight: 600 }}>
            Atualizar
          </button>
        </div>
      </header>

      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 24px' }}>
        {/* Filters */}
        <div style={{ background: 'white', borderRadius: 10, border: '1px solid #e2e8f0', padding: '14px 18px', marginBottom: 20, display: 'flex', gap: 12 }}>
          <input
            placeholder="Filtrar por namespace…"
            value={nsFilter}
            onChange={e => { setNsFilter(e.target.value); setOffset(0) }}
            style={{ flex: 1, border: '1px solid #e2e8f0', borderRadius: 6, padding: '7px 10px', fontSize: 12 }}
          />
          <input
            placeholder="Filtrar por ação…"
            value={actionFilter}
            onChange={e => { setActionFilter(e.target.value); setOffset(0) }}
            style={{ flex: 1, border: '1px solid #e2e8f0', borderRadius: 6, padding: '7px 10px', fontSize: 12 }}
          />
          <button onClick={() => { setNsFilter(''); setActionFilter(''); setOffset(0) }} style={{ background: '#f1f5f9', border: 'none', borderRadius: 6, padding: '7px 14px', fontSize: 12, color: '#475569', cursor: 'pointer' }}>
            Limpar
          </button>
        </div>

        <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e2e8f0', overflow: 'hidden' }}>
          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>Carregando…</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>Nenhum evento encontrado.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f8fafc' }}>
                  {['Data/Hora', 'Usuário', 'Ação', 'Recurso', 'Namespace', 'Detalhes'].map(h => (
                    <th key={h} style={{ ...cell, fontWeight: 700, fontSize: 10, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(log => (
                  <tr key={log.id} style={{ background: 'white' }}>
                    <td style={{ ...cell, color: '#94a3b8', fontSize: 11, whiteSpace: 'nowrap' }}>
                      {new Date(log.created_at).toLocaleString('pt-BR')}
                    </td>
                    <td style={{ ...cell, fontWeight: 600, color: '#1e293b' }}>{log.username || '—'}</td>
                    <td style={cell}><ActionBadge action={log.action} /></td>
                    <td style={{ ...cell, fontSize: 11 }}>
                      {log.resource_name && (
                        <code style={{ background: '#f1f5f9', padding: '1px 5px', borderRadius: 3 }}>{log.resource_name}</code>
                      )}
                    </td>
                    <td style={{ ...cell, fontSize: 11, color: '#64748b' }}>{log.namespace || '—'}</td>
                    <td style={{ ...cell, fontSize: 10, color: '#94a3b8' }}>{log.details || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {total > LIMIT && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16, fontSize: 12, color: '#64748b' }}>
            <span>Mostrando {offset + 1}–{Math.min(offset + LIMIT, total)} de {total}</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}
                style={{ background: '#f1f5f9', border: 'none', borderRadius: 6, padding: '6px 14px', fontSize: 12, cursor: offset === 0 ? 'not-allowed' : 'pointer', opacity: offset === 0 ? 0.5 : 1 }}>
                Anterior
              </button>
              <button disabled={offset + LIMIT >= total} onClick={() => setOffset(offset + LIMIT)}
                style={{ background: '#f1f5f9', border: 'none', borderRadius: 6, padding: '6px 14px', fontSize: 12, cursor: offset + LIMIT >= total ? 'not-allowed' : 'pointer', opacity: offset + LIMIT >= total ? 0.5 : 1 }}>
                Próxima
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
