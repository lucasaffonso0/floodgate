'use client'

import React, { useState, useEffect, useCallback } from 'react'
import PasswordModal from '@/components/PasswordModal'
import { ServiceInfo, NetworkPolicyInfo, Draft, PortSpec, AppConfig, User, ApprovalRequest, AutosyncStatus } from '@/types'
import {
  deleteNetworkPolicy, patchNetworkPolicyPort,
  getApprovalRequests, voteApprovalRequest, applyApprovalRequest, cancelApprovalRequest, getApprovalRequestYAML,
  getSecurityCoverage, applyDefaultDeny, isolateNamespace,
  getPausedPolicies, pauseAllPolicies, resumeAllPolicies,
  getAutosyncStatus, triggerAutosync, updateUserPassword, listUsers,
  adoptPolicy, unadoptPolicy,
} from '@/api/client'

// ─── YAML generator (rascunhos) ────────────────────────────────────────────
function generateYAML(draft: Draft, services: ServiceInfo[]): string {
  const src = services.find(s => s.name === draft.src_workload && s.namespace === draft.src_namespace)
  const dst = services.find(s => s.name === draft.dst_service && s.namespace === draft.dst_namespace)
  const srcSel = Object.entries(src?.selector ?? {}).map(([k, v]) => `              ${k}: "${v}"`).join('\n') || '              {}'
  const dstSel = Object.entries(dst?.selector ?? {}).map(([k, v]) => `      ${k}: "${v}"`).join('\n') || '      {}'
  const name = `floodgate-allow-${draft.src_workload}-${draft.src_namespace}-to-${draft.dst_service}`.slice(0, 63)
  const portsYaml = draft.dst_ports.map(p => `        - protocol: ${p.protocol}\n          port: ${p.port}`).join('\n')
  const ingressYaml = `apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: ${name}\n  namespace: ${draft.dst_namespace}\n  labels:\n    managed-by: floodgate\nspec:\n  podSelector:\n    matchLabels:\n${dstSel}\n  policyTypes:\n    - Ingress\n  ingress:\n    - from:\n        - namespaceSelector:\n            matchLabels:\n              kubernetes.io/metadata.name: ${draft.src_namespace}\n          podSelector:\n            matchLabels:\n${srcSel}\n      ports:\n${portsYaml}`
  const egressName = `floodgate-egress-${draft.src_workload}-to-${draft.dst_service}`.slice(0, 63)
  const egressYaml = `apiVersion: networking.k8s.io/v1\nkind: NetworkPolicy\nmetadata:\n  name: ${egressName}\n  namespace: ${draft.src_namespace}\n  labels:\n    managed-by: floodgate\nspec:\n  podSelector:\n    matchLabels:\n${srcSel}\n  policyTypes:\n    - Egress\n  egress:\n    - to:\n        - namespaceSelector:\n            matchLabels:\n              kubernetes.io/metadata.name: ${draft.dst_namespace}\n          podSelector:\n            matchLabels:\n${dstSel}\n      ports:\n${portsYaml}`
  if (draft.policy_direction === 'egress') return egressYaml
  if (draft.policy_direction === 'both') return `${ingressYaml}\n---\n${egressYaml}`
  return ingressYaml
}

// ─── Types ─────────────────────────────────────────────────────────────────
type Tab = 'namespaces' | 'drafts' | 'policies' | 'aprovacoes' | 'seguranca' | 'config'
type PausedPolicy = { id: string; name: string; namespace: string; policy_yaml: string; saved_at: string }

// ─── Icons ─────────────────────────────────────────────────────────────────
const Icon = {
  Namespace: () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>,
  Draft:     () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>,
  Policy:    () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  Config:    () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93l-1.41 1.41M4.93 4.93l1.41 1.41M12 2v2M12 20v2M2 12h2M20 12h2M19.07 19.07l-1.41-1.41M4.93 19.07l1.41-1.41"/></svg>,
  Trash:     () => <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6M10 11v6M14 11v6M9 6V4h6v2"/></svg>,
  Edit:      () => <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
  Check:     () => <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>,
  Download:  () => <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>,
  Eye:       () => <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>,
  Shield:    () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>,
  Clock:     () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>,
  Pause:     () => <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>,
  Play:      () => <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>,
  ChevronRight: () => <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="9 18 15 12 9 6"/></svg>,
  ChevronDown:  () => <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9"/></svg>,
  Alert:     () => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
  Tag:       () => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>,
}

// ─── Shared styles ──────────────────────────────────────────────────────────
const btn = {
  base:   { border: 'none', borderRadius: 5, cursor: 'pointer', fontSize: 11, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4, padding: '4px 9px' } as React.CSSProperties,
  green:  { background: '#10b981', color: 'white' } as React.CSSProperties,
  red:    { background: '#fee2e2', color: '#dc2626' } as React.CSSProperties,
  gray:   { background: '#f1f5f9', color: '#475569' } as React.CSSProperties,
  blue:   { background: '#eff6ff', color: '#2563eb' } as React.CSSProperties,
  orange: { background: '#fff7ed', color: '#c2410c' } as React.CSSProperties,
}

// ─── Toggle switch ──────────────────────────────────────────────────────────
function ToggleSwitch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!on)} role="switch" aria-checked={on}
      style={{ width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer', background: on ? '#10b981' : '#cbd5e1', position: 'relative', flexShrink: 0, transition: 'background 0.2s', padding: 0 }}>
      <span style={{ position: 'absolute', top: 2, left: on ? 18 : 2, width: 16, height: 16, borderRadius: '50%', background: 'white', transition: 'left 0.2s', display: 'block' }} />
    </button>
  )
}

// ─── Static YAML viewer ────────────────────────────────────────────────────
function StaticYAMLViewer({ yamlStr }: { yamlStr: string }) {
  return (
    <div style={{ margin: '4px 14px 10px', position: 'relative' }}>
      <pre style={{ background: '#0f172a', color: '#7dd3fc', fontSize: 9.5, lineHeight: 1.6, borderRadius: 8, padding: '10px 12px', overflowX: 'auto', margin: 0, fontFamily: 'ui-monospace, monospace', maxHeight: 200 }}>{yamlStr}</pre>
      <button style={{ position: 'absolute', top: 5, right: 5, background: '#1e293b', color: '#94a3b8', border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 10, fontWeight: 600, padding: '3px 7px' }}
        onClick={() => navigator.clipboard.writeText(yamlStr)}>Copiar</button>
    </div>
  )
}

// ─── Live YAML viewer (fetches from K8s) ───────────────────────────────────
function LiveYAMLViewer({ namespace, name }: { namespace: string; name: string }) {
  const [yamlStr, setYamlStr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    fetch(`/api/networkpolicies/${namespace}/${name}`)
      .then(r => r.text()).then(t => { setYamlStr(t); setLoading(false) })
      .catch(() => { setYamlStr('# Erro ao carregar YAML'); setLoading(false) })
  }, [namespace, name])
  if (loading) return <div style={{ margin: '4px 14px 10px', background: '#0f172a', borderRadius: 8, padding: '10px 12px', fontSize: 10, color: '#64748b' }}>Carregando…</div>
  return <StaticYAMLViewer yamlStr={yamlStr ?? ''} />
}

// ─── Namespaces tab ─────────────────────────────────────────────────────────
function NamespacesTab({ allNamespaces, services, visibleNamespaces, ignoredNamespaces, onToggle }: {
  allNamespaces: string[]; services: ServiceInfo[]; visibleNamespaces: Set<string>; ignoredNamespaces: string[]; onToggle: (ns: string) => void
}) {
  const [ignoredOpen, setIgnoredOpen] = useState(false)
  const [search, setSearch] = useState('')
  const svcCount = (ns: string) => services.filter(s => s.namespace === ns).length
  const filtered = allNamespaces.filter(ns => ns.toLowerCase().includes(search.toLowerCase()))
  const allFilteredOn = filtered.length > 0 && filtered.every(ns => visibleNamespaces.has(ns))
  function toggleAll() { filtered.forEach(ns => { if (allFilteredOn ? visibleNamespaces.has(ns) : !visibleNamespaces.has(ns)) onToggle(ns) }) }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px 8px', borderBottom: '1px solid #f1f5f9', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="text" placeholder="Buscar namespace…" value={search} onChange={e => setSearch(e.target.value)}
            style={{ flex: 1, border: '1px solid #e2e8f0', borderRadius: 6, padding: '5px 8px', fontSize: 11, outline: 'none' }} />
          <button style={{ ...btn.base, ...btn.gray, fontSize: 10, flexShrink: 0 }} onClick={toggleAll}>
            {allFilteredOn ? 'Desmarcar' : 'Marcar'} {search ? 'filtrados' : 'todos'}
          </button>
        </div>
        {search && <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 4 }}>{filtered.length} de {allNamespaces.length}</div>}
      </div>
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filtered.map(ns => (
          <label key={ns} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderBottom: '1px solid #f9fafb', cursor: 'pointer' }}>
            <input type="checkbox" checked={visibleNamespaces.has(ns)} onChange={() => onToggle(ns)} style={{ accentColor: '#3b82f6', width: 14, height: 14 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ns}</div>
              <div style={{ fontSize: 10, color: '#94a3b8' }}>{svcCount(ns)} serviço(s)</div>
            </div>
          </label>
        ))}
        {filtered.length === 0 && <div style={{ padding: '20px 14px', textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>Nenhum namespace encontrado</div>}
        {ignoredNamespaces.length > 0 && (
          <div style={{ borderTop: '2px solid #f1f5f9' }}>
            <button onClick={() => setIgnoredOpen(v => !v)} style={{ width: '100%', padding: '8px 14px', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 10, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              <span>Ignorados ({ignoredNamespaces.length})</span>
              {ignoredOpen ? <Icon.ChevronDown /> : <Icon.ChevronRight />}
            </button>
            {ignoredOpen && ignoredNamespaces.map(ns => (
              <div key={ns} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px', opacity: 0.5 }}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
                <span style={{ fontSize: 11, color: '#64748b' }}>{ns}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Drafts tab ─────────────────────────────────────────────────────────────
// ─── New draft modal ───────────────────────────────────────────────────────
function NewDraftModal({ services, onAdd, onClose }: {
  services: ServiceInfo[]
  onAdd: (d: Omit<Draft, 'id'>) => void
  onClose: () => void
}) {
  const namespaces = Array.from(new Set(services.map(s => s.namespace))).sort()

  const [srcNs, setSrcNs]   = useState(namespaces[0] ?? '')
  const [srcSvc, setSrcSvc] = useState('')
  const [dstNs, setDstNs]   = useState(namespaces[0] ?? '')
  const [dstSvc, setDstSvc] = useState('')
  const [ports, setPorts]   = useState<PortSpec[]>([{ port: 80, protocol: 'TCP' }])
  const [dir, setDir]       = useState<'ingress' | 'egress' | 'both'>('both')

  const srcServices = services.filter(s => s.namespace === srcNs).map(s => s.name).sort()
  const dstServices = services.filter(s => s.namespace === dstNs).map(s => s.name).sort()

  const canSubmit = srcNs.trim() && srcSvc.trim() && dstNs.trim() && dstSvc.trim() && ports.length > 0 && ports.every(p => p.port >= 1 && p.port <= 65535)

  function handleSubmit() {
    if (!canSubmit) return
    onAdd({ src_namespace: srcNs.trim(), src_workload: srcSvc.trim(), dst_namespace: dstNs.trim(), dst_service: dstSvc.trim(), dst_ports: ports, policy_direction: dir })
    onClose()
  }

  const labelStyle: React.CSSProperties = { fontSize: 10, fontWeight: 600, color: '#64748b', marginBottom: 4, display: 'block' }
  const inputStyle: React.CSSProperties = { width: '100%', border: '1px solid #e2e8f0', borderRadius: 6, padding: '6px 8px', fontSize: 11, boxSizing: 'border-box', outline: 'none', background: 'white' }
  const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer' }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: 'white', borderRadius: 14, width: 360, boxShadow: '0 8px 40px rgba(0,0,0,0.18)', border: '1px solid #e2e8f0', overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0', padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>Nova política</div>
            <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 1 }}>Cria um rascunho — aplique depois</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 18, lineHeight: 1, padding: 2 }}>✕</button>
        </div>

        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Source */}
          <div style={{ background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: '#0369a1', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Origem</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Namespace</label>
                <select value={srcNs} onChange={e => { setSrcNs(e.target.value); setSrcSvc('') }} style={selectStyle}>
                  {namespaces.map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Serviço / workload</label>
                <input
                  list="src-svc-list"
                  value={srcSvc}
                  onChange={e => setSrcSvc(e.target.value)}
                  placeholder={srcServices[0] ?? 'nome do serviço'}
                  style={inputStyle}
                />
                <datalist id="src-svc-list">
                  {srcServices.map(s => <option key={s} value={s} />)}
                </datalist>
              </div>
            </div>
          </div>

          {/* Direction indicator */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
            {(['ingress', 'both', 'egress'] as const).map(d => (
              <button key={d} onClick={() => setDir(d)} style={{
                padding: '4px 10px', fontSize: 10, fontWeight: 700, borderRadius: 99,
                border: `1.5px solid ${dir === d ? '#2563eb' : '#e2e8f0'}`,
                background: dir === d ? '#eff6ff' : 'white',
                color: dir === d ? '#2563eb' : '#94a3b8',
                cursor: 'pointer',
              }}>
                {d === 'ingress' ? '↙ Ingress' : d === 'egress' ? '↗ Egress' : '↔ Ambos'}
              </button>
            ))}
          </div>

          {/* Destination */}
          <div style={{ background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: '#15803d', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>Destino</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Namespace</label>
                <select value={dstNs} onChange={e => { setDstNs(e.target.value); setDstSvc('') }} style={selectStyle}>
                  {namespaces.map(n => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
              <div style={{ flex: 1 }}>
                <label style={labelStyle}>Serviço</label>
                <input
                  list="dst-svc-list"
                  value={dstSvc}
                  onChange={e => setDstSvc(e.target.value)}
                  placeholder={dstServices[0] ?? 'nome do serviço'}
                  style={inputStyle}
                />
                <datalist id="dst-svc-list">
                  {dstServices.map(s => <option key={s} value={s} />)}
                </datalist>
              </div>
            </div>
          </div>

          {/* Ports */}
          <div>
            <label style={labelStyle}>Portas</label>
            {ports.map((ps, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                <select value={ps.protocol} onChange={e => setPorts(prev => prev.map((p, j) => j === i ? { ...p, protocol: e.target.value as PortSpec['protocol'] } : p))}
                  style={{ ...selectStyle, width: 80 }}>
                  <option value="TCP">TCP</option>
                  <option value="UDP">UDP</option>
                  <option value="SCTP">SCTP</option>
                </select>
                <input type="number" value={ps.port} min={1} max={65535}
                  onChange={e => setPorts(prev => prev.map((p, j) => j === i ? { ...p, port: parseInt(e.target.value) || 1 } : p))}
                  style={{ ...inputStyle, width: 80 }} />
                {ports.length > 1 && (
                  <button onClick={() => setPorts(prev => prev.filter((_, j) => j !== i))}
                    style={{ background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 5, cursor: 'pointer', padding: '4px 7px', fontSize: 11 }}>✕</button>
                )}
              </div>
            ))}
            <button onClick={() => setPorts(prev => [...prev, { port: 80, protocol: 'TCP' as const }])}
              style={{ ...inputStyle, width: 'auto', background: '#f1f5f9', color: '#475569', cursor: 'pointer', border: '1px dashed #cbd5e1', fontSize: 10, fontWeight: 600, padding: '4px 10px' }}>
              + Adicionar porta
            </button>
          </div>

          {/* Submit */}
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            style={{
              width: '100%', padding: '9px', fontSize: 11, fontWeight: 600,
              background: canSubmit ? '#2563eb' : '#e2e8f0', color: canSubmit ? 'white' : '#94a3b8',
              border: 'none', borderRadius: 7, cursor: canSubmit ? 'pointer' : 'not-allowed',
            }}
          >
            Criar rascunho
          </button>
        </div>
      </div>
    </div>
  )
}

function DraftsTab({ drafts, services, config, currentUser, onRemove, onApply, onApplyAll, onDiscardAll, onUpdatePort, onAddDraft }: {
  drafts: Draft[]; services: ServiceInfo[]; config: AppConfig; currentUser: User | null
  onRemove: (id: string) => void
  onApply: (d: Draft, allowedApprovers: Array<{ id: string; username: string }>) => Promise<void>
  onApplyAll: () => Promise<void>; onDiscardAll: () => void; onUpdatePort: (id: string, ports: PortSpec[]) => void
  onAddDraft: (d: Omit<Draft, 'id'>) => void
}) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const [applying, setApplying] = useState<string | null>(null)
  const [pickerDraft, setPickerDraft] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [approverSearch, setApproverSearch] = useState('')
  const [users, setUsers] = useState<User[]>([])
  const [showNewModal, setShowNewModal] = useState(false)

  useEffect(() => {
    if (config.approval_enabled) listUsers().then(setUsers).catch(() => {})
  }, [config.approval_enabled])

  function toggleUser(id: string) {
    setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }

  async function handleApply(d: Draft) {
    if (config.approval_enabled) {
      const defaultIds = new Set(
        (config.approval_default_approvers ?? [])
          .filter(a => a.id !== currentUser?.id)
          .map(a => a.id)
      )
      setPickerDraft(d.id); setSelectedIds(defaultIds); setApproverSearch(''); return
    }
    setApplying(d.id)
    try { await onApply(d, []) } finally { setApplying(null) }
  }

  async function confirmApply(d: Draft) {
    const approvers = users.filter(u => selectedIds.has(u.id)).map(u => ({ id: u.id, username: u.username }))
    setPickerDraft(null)
    setApplying(d.id)
    try { await onApply(d, approvers) } finally { setApplying(null) }
  }

  const otherUsers = users
    .filter(u => u.id !== currentUser?.id)
    .filter(u => !approverSearch || u.username.toLowerCase().includes(approverSearch.toLowerCase()))

  if (drafts.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 12, gap: 10, padding: 24, textAlign: 'center' }}>
        <Icon.Draft />
        <div>Nenhum rascunho.<br/>Conecte serviços no grafo ou crie manualmente.</div>
        <button
          onClick={() => setShowNewModal(true)}
          style={{ ...btn.base, ...btn.blue, fontSize: 11, padding: '6px 14px', marginTop: 4 }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Nova política
        </button>
        {showNewModal && <NewDraftModal services={services} onAdd={onAddDraft} onClose={() => setShowNewModal(false)} />}
      </div>
    )
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px 8px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid #f1f5f9', flexShrink: 0 }}>
        <span style={{ fontSize: 11, color: '#94a3b8' }}>{drafts.length} rascunho(s)</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button style={{ ...btn.base, ...btn.blue }} onClick={() => setShowNewModal(true)}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Nova
          </button>
          <button style={{ ...btn.base, ...btn.red }} onClick={onDiscardAll}><Icon.Trash /> Descartar todos</button>
          <button style={{ ...btn.base, ...btn.green }} onClick={onApplyAll}><Icon.Check /> Aplicar todos</button>
        </div>
      </div>
      {showNewModal && <NewDraftModal services={services} onAdd={onAddDraft} onClose={() => setShowNewModal(false)} />}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {drafts.map(draft => {
          const isExpanded = expanded === draft.id
          const isPicker   = pickerDraft === draft.id
          return (
            <div key={draft.id} style={{ borderBottom: '1px solid #f9fafb' }}>
              <div style={{ padding: '10px 14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11, fontWeight: 600, color: '#2563eb', background: '#eff6ff', borderRadius: 4, padding: '1px 6px' }}>{draft.src_namespace}/{draft.src_workload}</span>
                  <span style={{ color: '#94a3b8', fontSize: 10 }}>→</span>
                  <span style={{ fontSize: 11, fontWeight: 600, color: '#16a34a', background: '#f0fdf4', borderRadius: 4, padding: '1px 6px' }}>{draft.dst_namespace}/{draft.dst_service}</span>
                </div>
                <div style={{ marginBottom: 8 }}>
                  {draft.dst_ports.map((ps, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                      <select value={ps.protocol} onChange={e => {
                        const next = draft.dst_ports.map((p, j) => j === i ? { ...p, protocol: e.target.value as PortSpec['protocol'] } : p)
                        onUpdatePort(draft.id, next)
                      }} style={{ border: '1px solid #cbd5e1', borderRadius: 5, padding: '3px 5px', fontSize: 10, background: 'white', cursor: 'pointer' }}>
                        <option value="TCP">TCP</option>
                        <option value="UDP">UDP</option>
                        <option value="SCTP">SCTP</option>
                      </select>
                      <input type="number" value={ps.port} min={1} max={65535} onChange={e => {
                        const next = draft.dst_ports.map((p, j) => j === i ? { ...p, port: parseInt(e.target.value) || 80 } : p)
                        onUpdatePort(draft.id, next)
                      }} style={{ width: 60, border: '1px solid #cbd5e1', borderRadius: 5, padding: '3px 6px', fontSize: 11 }} />
                      {draft.dst_ports.length > 1 && (
                        <button onClick={() => onUpdatePort(draft.id, draft.dst_ports.filter((_, j) => j !== i))}
                          style={{ ...btn.base, ...btn.red, padding: '2px 6px' }}><Icon.Trash /></button>
                      )}
                    </div>
                  ))}
                  <button onClick={() => onUpdatePort(draft.id, [...draft.dst_ports, { port: 80, protocol: 'TCP' as const }])}
                    style={{ ...btn.base, ...btn.gray, fontSize: 10, padding: '2px 8px', marginTop: 2 }}>
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                    Porta
                  </button>
                </div>
                <div style={{ display: 'flex', gap: 5 }}>
                  <button style={{ ...btn.base, ...btn.blue }} onClick={() => setExpanded(isExpanded ? null : draft.id)}><Icon.Eye /> {isExpanded ? 'Ocultar' : 'YAML'}</button>
                  <button style={{ ...btn.base, ...btn.green, opacity: applying === draft.id ? 0.6 : 1 }} onClick={() => handleApply(draft)} disabled={applying === draft.id}>
                    <Icon.Check /> {applying === draft.id ? '…' : config.approval_enabled ? 'Enviar para aprovação' : 'Aplicar'}
                  </button>
                  <button style={{ ...btn.base, ...btn.red }} onClick={() => onRemove(draft.id)}><Icon.Trash /></button>
                </div>
              </div>

              {/* Approver picker — shown when approval is enabled and user clicked the button */}
              {isPicker && (
                <div style={{ margin: '0 14px 10px', background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8, padding: '10px 12px' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#475569', marginBottom: 8 }}>
                    Quem pode aprovar este request?
                  </div>
                  <input
                    type="text"
                    placeholder="Buscar usuário…"
                    value={approverSearch}
                    onChange={e => setApproverSearch(e.target.value)}
                    style={{ width: '100%', border: '1px solid #e2e8f0', borderRadius: 5, padding: '4px 7px', fontSize: 11, marginBottom: 7, boxSizing: 'border-box', outline: 'none' }}
                  />
                  {otherUsers.length === 0 ? (
                    <div style={{ fontSize: 11, color: '#64748b', marginBottom: 8, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6, padding: '7px 9px' }}>
                      {approverSearch
                        ? `Nenhum usuário encontrado para "${approverSearch}".`
                        : users.length === 0
                          ? 'Os aprovadores serão preenchidos automaticamente: admins e ns_admins com acesso à namespace de destino.'
                          : 'Nenhum outro usuário disponível.'}
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginBottom: 10, maxHeight: 140, overflowY: 'auto' }}>
                      {otherUsers.map(u => (
                        <label key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 11 }}>
                          <input type="checkbox" checked={selectedIds.has(u.id)} onChange={() => toggleUser(u.id)}
                            style={{ accentColor: '#185FA5', width: 13, height: 13 }} />
                          <span style={{ fontWeight: 600, color: '#0f172a' }}>{u.username}</span>
                          <span style={{ fontSize: 10, color: '#94a3b8', background: '#f1f5f9', borderRadius: 4, padding: '1px 5px' }}>{u.role}</span>
                        </label>
                      ))}
                    </div>
                  )}
                  <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 8 }}>
                    {selectedIds.size === 0 ? 'Sem seleção: qualquer usuário poderá votar.' : `${selectedIds.size} aprovador(es) selecionado(s).`}
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button style={{ ...btn.base, ...btn.green }} onClick={() => confirmApply(draft)}>
                      <Icon.Check /> Confirmar envio
                    </button>
                    <button style={{ ...btn.base, ...btn.gray }} onClick={() => setPickerDraft(null)}>Cancelar</button>
                  </div>
                </div>
              )}

              {isExpanded && <StaticYAMLViewer yamlStr={generateYAML(draft, services)} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Policy edit modal ─────────────────────────────────────────────────────
function PolicyEditModal({ policy, onClose, onSaved }: {
  policy: NetworkPolicyInfo
  onClose: () => void
  onSaved: () => void
}) {
  const [ports, setPorts] = useState<PortSpec[]>(
    policy.dst_ports && policy.dst_ports.length > 0 ? policy.dst_ports : [{ port: policy.dst_port || 80, protocol: 'TCP' }]
  )
  const [saving, setSaving] = useState(false)
  const inputStyle: React.CSSProperties = { border: '1px solid #cbd5e1', borderRadius: 6, padding: '6px 8px', fontSize: 12, outline: 'none', background: 'white' }

  async function handleSave() {
    setSaving(true)
    try {
      await patchNetworkPolicyPort(policy.namespace, policy.name, ports)
      onSaved()
      onClose()
    } catch (e: unknown) {
      alert((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 400, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div style={{ background: 'white', borderRadius: 14, width: 340, boxShadow: '0 8px 40px rgba(0,0,0,0.18)', border: '1px solid #e2e8f0', overflow: 'hidden' }}>
        <div style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0', padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: '#0f172a' }}>Editar NetworkPolicy</div>
            <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>{policy.name}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 18 }}>✕</button>
        </div>
        <div style={{ padding: 16 }}>
          <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 10 }}>
            <code style={{ background: '#eff6ff', color: '#2563eb', padding: '2px 5px', borderRadius: 4, fontSize: 10 }}>{policy.src_namespace}/{policy.src_workload}</code>
            <span style={{ margin: '0 5px', color: '#94a3b8' }}>→</span>
            <code style={{ background: '#f0fdf4', color: '#16a34a', padding: '2px 5px', borderRadius: 4, fontSize: 10 }}>{policy.namespace}/{policy.dst_service}</code>
          </div>
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#475569', marginBottom: 6 }}>Portas</label>
            {ports.map((ps, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                <select value={ps.protocol} onChange={e => setPorts(prev => prev.map((p, j) => j === i ? { ...p, protocol: e.target.value as PortSpec['protocol'] } : p))}
                  style={{ ...inputStyle, cursor: 'pointer', flexShrink: 0 }}>
                  <option value="TCP">TCP</option>
                  <option value="UDP">UDP</option>
                  <option value="SCTP">SCTP</option>
                </select>
                <input type="number" value={ps.port} min={1} max={65535}
                  onChange={e => setPorts(prev => prev.map((p, j) => j === i ? { ...p, port: parseInt(e.target.value) || 1 } : p))}
                  style={{ ...inputStyle, flex: 1 }} />
                {ports.length > 1 && (
                  <button onClick={() => setPorts(prev => prev.filter((_, j) => j !== i))}
                    style={{ background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 5, cursor: 'pointer', padding: '5px 8px', fontSize: 12 }}>✕</button>
                )}
              </div>
            ))}
            <button onClick={() => setPorts(prev => [...prev, { port: 80, protocol: 'TCP' as const }])}
              style={{ fontSize: 10, fontWeight: 600, color: '#475569', background: '#f1f5f9', border: '1px dashed #cbd5e1', borderRadius: 5, cursor: 'pointer', padding: '4px 10px' }}>
              + Adicionar porta
            </button>
            <div style={{ fontSize: 10, color: '#f59e0b', marginTop: 6 }}>A policy será recriada ao salvar.</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleSave} disabled={saving}
              style={{ flex: 1, background: saving ? '#93c5fd' : '#2563eb', color: 'white', border: 'none', borderRadius: 7, padding: '9px', fontSize: 12, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer' }}>
              {saving ? 'Salvando…' : 'Salvar'}
            </button>
            <button onClick={onClose}
              style={{ flex: 1, background: '#f1f5f9', color: '#475569', border: 'none', borderRadius: 7, padding: '9px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
              Cancelar
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Policies tab ──────────────────────────────────────────────────────────
const POLICY_META: Record<string, { dot: string; label: string }> = {
  'allow':                { dot: '#10b981', label: 'Allow IN' },
  'allow-egress':         { dot: '#8b5cf6', label: 'Allow OUT' },
  'allow-namespace':      { dot: '#0891b2', label: 'Allow NS' },
  'allow-intranamespace': { dot: '#0284c7', label: 'Allow Intra' },
  'restrict-ingress':     { dot: '#ef4444', label: 'Deny IN' },
  'restrict-egress':      { dot: '#f97316', label: 'Deny OUT' },
  'external':             { dot: '#94a3b8', label: 'Ext' },
}

function policyDescription(p: NetworkPolicyInfo): string {
  if (p.policy_type === 'allow' || p.policy_type === 'allow-egress') {
    if (p.src_workload && p.dst_service) {
      return `${p.src_namespace}/${p.src_workload} → ${p.dst_service}${p.dst_port > 0 ? `:${p.dst_port}` : ''}`
    }
  }
  if (p.policy_type === 'allow-namespace' && p.src_namespace && p.dst_service) {
    return `ns:${p.src_namespace} → ${p.dst_service}${p.dst_port > 0 ? `:${p.dst_port}` : ''}`
  }
  if (p.policy_type === 'allow-intranamespace') {
    return `intra-namespace: ${p.namespace}`
  }
  if (p.policy_type === 'restrict-ingress' || p.policy_type === 'restrict-egress') {
    return p.dst_service || p.name
  }
  return p.name
}

function PoliciesTab({ policies, allPolicies, services, isAdmin, isViewer, canManageNamespace, onDelete, onRefresh }: {
  policies: NetworkPolicyInfo[]; allPolicies: NetworkPolicyInfo[]; services: ServiceInfo[]; isAdmin?: boolean; isViewer?: boolean; canManageNamespace?: (namespace: string) => boolean; onDelete: () => void; onRefresh: () => void
}) {
  const [expandedYAML, setExpandedYAML] = useState<string | null>(null)
  const [expandedNs, setExpandedNs] = useState<Set<string>>(new Set())
  const [showExternal, setShowExternal] = useState(false)
  const [paused, setPaused] = useState<PausedPolicy[]>([])
  const [pausing, setPausing] = useState(false)
  const [resuming, setResuming] = useState(false)
  const [filter, setFilter] = useState('')
  const [adoptingPolicy, setAdoptingPolicy] = useState<NetworkPolicyInfo | null>(null)
  const [adoptType, setAdoptType] = useState('')
  const [adopting, setAdopting] = useState(false)
  const [editingPolicy, setEditingPolicy] = useState<NetworkPolicyInfo | null>(null)

  function toggleYAML(key: string) { setExpandedYAML(prev => prev === key ? null : key) }

  function guessAdoptType(p: NetworkPolicyInfo): string {
    const types = p.policy_types.map(t => t.toLowerCase())
    const hasIngress = types.includes('ingress')
    const hasEgress = types.includes('egress')
    if (hasIngress && hasEgress) return 'restrict-ingress'
    if (hasIngress && p.ingress_count === 0) return 'restrict-ingress'
    if (hasEgress && p.egress_count === 0) return 'restrict-egress'
    if (hasIngress) return 'allow'
    if (hasEgress) return 'allow-egress'
    return 'allow'
  }

  function openAdopt(p: NetworkPolicyInfo) {
    setAdoptingPolicy(p)
    setAdoptType(guessAdoptType(p))
  }

  async function confirmAdopt() {
    if (!adoptingPolicy) return
    setAdopting(true)
    try {
      await adoptPolicy(adoptingPolicy.namespace, adoptingPolicy.name, adoptType)
      setAdoptingPolicy(null)
      onRefresh()
    } catch (e: unknown) {
      alert((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? String(e))
    } finally {
      setAdopting(false)
    }
  }

  async function handleUnadopt(p: NetworkPolicyInfo) {
    if (!confirm(`Desadotar "${p.name}"? A policy continuará existindo no cluster, mas deixará de ser gerenciada pelo Floodgate.`)) return
    try {
      await unadoptPolicy(p.namespace, p.name)
      onRefresh()
    } catch (e: unknown) {
      alert((e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ?? String(e))
    }
  }
  function toggleNs(ns: string) { setExpandedNs(prev => { const n = new Set(prev); n.has(ns) ? n.delete(ns) : n.add(ns); return n }) }

  // Orphan detection: managed policies whose src/dst service no longer exists
  const serviceSet = new Set(services.map(s => `${s.namespace}/${s.name}`))
  function isOrphaned(p: NetworkPolicyInfo): boolean {
    if (p.policy_type === 'external' || p.policy_type === 'allow-intranamespace') return false
    if (p.policy_type === 'allow') {
      const srcOk = !p.src_workload || serviceSet.has(`${p.src_namespace}/${p.src_workload}`)
      const dstOk = !p.dst_service || serviceSet.has(`${p.namespace}/${p.dst_service}`)
      return !srcOk || !dstOk
    }
    if (p.policy_type === 'allow-egress') {
      // policy lives in src_namespace; dst_service is in an unknown namespace
      const srcOk = !p.src_workload || serviceSet.has(`${p.namespace}/${p.src_workload}`)
      const dstOk = !p.dst_service || p.dst_service === 'internet' || services.some(s => s.name === p.dst_service)
      return !srcOk || !dstOk
    }
    // restrict-ingress, restrict-egress, allow-namespace: dst_service lives in p.namespace
    return !!p.dst_service && !serviceSet.has(`${p.namespace}/${p.dst_service}`)
  }
  const orphaned = policies.filter(isOrphaned)

  async function handleCleanupOrphaned() {
    if (!confirm(`Remover ${orphaned.length} policy(s) obsoleta(s)?`)) return
    await Promise.all(orphaned.map(p => deleteNetworkPolicy(p.namespace, p.name).catch(() => {})))
    onDelete()
  }

  const loadPaused = useCallback(async () => {
    if (isAdmin) setPaused(await getPausedPolicies().catch(() => []))
  }, [isAdmin])

  useEffect(() => { loadPaused() }, [loadPaused, policies])

  async function handlePause() {
    if (!confirm(`Pausar ${policies.length} policies? Elas serão removidas do cluster mas salvas para restauração.`)) return
    setPausing(true)
    try { await pauseAllPolicies(); onRefresh(); await loadPaused() } finally { setPausing(false) }
  }

  async function handleResume() {
    setResuming(true)
    try { await resumeAllPolicies(); onRefresh(); await loadPaused() } finally { setResuming(false) }
  }

  async function handleDelete(ns: string, name: string) {
    if (!confirm('Remover esta NetworkPolicy?')) return
    await deleteNetworkPolicy(ns, name); onDelete()
  }

  // Active policy keys (used to deduplicate paused list — if a policy survived pause deletion it appears in both)
  const activePolicyKeys = new Set(policies.map(p => `${p.namespace}/${p.name}`))

  // Filter helpers
  const q = filter.toLowerCase()
  const matchPolicy = (p: NetworkPolicyInfo) =>
    !q || p.namespace.includes(q) || p.dst_service.includes(q) || p.src_workload.includes(q) || p.name.includes(q)
  const matchPaused = (p: PausedPolicy) =>
    !q || p.namespace.includes(q) || p.name.includes(q)

  // Group filtered active policies by namespace
  const grouped = new Map<string, NetworkPolicyInfo[]>()
  for (const p of policies.filter(matchPolicy)) {
    if (!grouped.has(p.namespace)) grouped.set(p.namespace, [])
    grouped.get(p.namespace)!.push(p)
  }

  // Group filtered paused policies by namespace (exclude any that also appear as active — pause deletion failed)
  const pausedByNs = new Map<string, PausedPolicy[]>()
  for (const p of paused.filter(matchPaused).filter(p => !activePolicyKeys.has(`${p.namespace}/${p.name}`))) {
    if (!pausedByNs.has(p.namespace)) pausedByNs.set(p.namespace, [])
    pausedByNs.get(p.namespace)!.push(p)
  }

  // All namespaces that have active or paused policies
  const allNs = [...new Set([...grouped.keys(), ...pausedByNs.keys()])].sort()

  // Default: expand all namespaces
  useEffect(() => {
    if (allNs.length > 0 && expandedNs.size === 0) setExpandedNs(new Set(allNs))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policies.length, paused.length])

  const external = allPolicies.filter(p => !p.managed)
  const totalPaused = paused.filter(p => !activePolicyKeys.has(`${p.namespace}/${p.name}`)).length

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {editingPolicy && (
        <PolicyEditModal
          policy={editingPolicy}
          onClose={() => setEditingPolicy(null)}
          onSaved={() => { setEditingPolicy(null); onRefresh() }}
        />
      )}
      {/* Header */}
      <div style={{ padding: '10px 14px 8px', borderBottom: '1px solid #f1f5f9', flexShrink: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <div style={{ fontSize: 11, color: '#94a3b8' }}>
            <span style={{ fontWeight: 600, color: '#1e293b' }}>{policies.length}</span> ativas
            {totalPaused > 0 && <span style={{ marginLeft: 6, color: '#94a3b8', fontWeight: 600 }}>· {totalPaused} pausadas</span>}
            {external.length > 0 && <span style={{ marginLeft: 6 }}>· {external.length} ext.</span>}
          </div>
          <a href="/api/networkpolicies/export" download="floodgate-policies.yaml" style={{ ...btn.base, ...btn.blue, textDecoration: 'none', fontSize: 10 }}>
            <Icon.Download /> Export
          </a>
        </div>
        {isAdmin && (
          <div style={{ display: 'flex', gap: 5, marginBottom: 6 }}>
            {totalPaused > 0 ? (
              <button style={{ ...btn.base, ...btn.green, fontSize: 10 }} onClick={handleResume} disabled={resuming}>
                <Icon.Play /> {resuming ? 'Restaurando…' : `Restaurar ${totalPaused} pausadas`}
              </button>
            ) : (
              <button style={{ ...btn.base, ...btn.orange, fontSize: 10 }} onClick={handlePause} disabled={pausing || policies.length === 0}>
                <Icon.Pause /> {pausing ? 'Pausando…' : 'Pausar todas'}
              </button>
            )}
          </div>
        )}
        {/* Orphan banner */}
        {orphaned.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#fff1f2', border: '1px solid #fecdd3', borderRadius: 6, padding: '5px 8px', marginBottom: 6 }}>
            <span style={{ fontSize: 10, color: '#dc2626', fontWeight: 600 }}>
              {orphaned.length} obsoleta(s) — serviço removido do cluster
            </span>
            {isAdmin && (
              <button style={{ ...btn.base, ...btn.red, padding: '2px 7px', fontSize: 9 }} onClick={handleCleanupOrphaned}>
                <Icon.Trash /> Limpar
              </button>
            )}
          </div>
        )}
        {/* Filter */}
        <input
          type="text"
          placeholder="Filtrar por serviço ou namespace…"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          style={{ width: '100%', border: '1px solid #e2e8f0', borderRadius: 6, padding: '5px 8px', fontSize: 11, outline: 'none', boxSizing: 'border-box' }}
        />
        {filter && (
          <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 3 }}>
            {[...grouped.values()].reduce((s, a) => s + a.length, 0) + [...pausedByNs.values()].reduce((s, a) => s + a.length, 0)} resultado(s)
            <button onClick={() => setFilter('')} style={{ marginLeft: 6, background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 10 }}>✕ limpar</button>
          </div>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {allNs.length === 0 && !filter && (
          <div style={{ padding: '32px 16px', textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>
            <div style={{ marginBottom: 8 }}><Icon.Policy /></div>
            Nenhuma policy gerenciada.<br/>Aplique rascunhos para começar.
          </div>
        )}
        {allNs.length === 0 && filter && (
          <div style={{ padding: '32px 16px', textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>
            Nenhuma policy encontrada para "{filter}".
          </div>
        )}

        {/* Policies grouped by namespace — active + paused inline */}
        {allNs.map(ns => {
          const nsPolicies = grouped.get(ns) ?? []
          const nsPaused   = pausedByNs.get(ns) ?? []
          const isOpen     = expandedNs.has(ns)
          const total      = nsPolicies.length + nsPaused.length
          return (
            <div key={ns}>
              <button onClick={() => toggleNs(ns)}
                style={{ width: '100%', padding: '7px 14px', background: '#f8fafc', border: 'none', borderBottom: '1px solid #e2e8f0', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, textAlign: 'left' }}>
                {isOpen ? <Icon.ChevronDown /> : <Icon.ChevronRight />}
                <span style={{ fontSize: 11, fontWeight: 700, color: '#334155', flex: 1 }}>{ns}</span>
                <span style={{ fontSize: 10, color: '#94a3b8', background: '#e2e8f0', borderRadius: 10, padding: '1px 7px', fontWeight: 600 }}>{total}</span>
              </button>

              {isOpen && (
                <>
                  {/* Active policies */}
                  {nsPolicies.map(p => {
                    const key = `${p.namespace}/${p.name}`
                    const m = POLICY_META[p.policy_type] ?? POLICY_META['external']
                    const orphan = isOrphaned(p)
                    return (
                      <div key={key} style={{ borderBottom: '1px solid #f9fafb', background: orphan ? '#fff8f8' : undefined }}>
                        <div style={{ padding: '8px 14px 8px 20px', display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: orphan ? '#fca5a5' : m.dot, flexShrink: 0 }} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                              <span style={{ fontSize: 11, fontWeight: 600, color: orphan ? '#b91c1c' : '#1e293b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                {policyDescription(p)}
                              </span>
                              {orphan && (
                                <span style={{ fontSize: 8, fontWeight: 700, color: '#dc2626', background: '#fee2e2', border: '1px solid #fca5a5', borderRadius: 3, padding: '1px 4px', flexShrink: 0 }}>OBSOLETA</span>
                              )}
                            </div>
                            <div style={{ fontSize: 9, color: orphan ? '#fca5a5' : '#94a3b8', marginTop: 1 }}>{m.label}</div>
                          </div>
                          <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                            <button style={{ ...btn.base, ...btn.blue, padding: '3px 7px', fontSize: 10 }} onClick={() => toggleYAML(key)}><Icon.Eye /></button>
                            {!isViewer && (!canManageNamespace || canManageNamespace(p.namespace)) && (
                              <>
                                {(p.policy_type === 'allow' || p.policy_type === 'allow-egress') && (
                                  <button style={{ ...btn.base, ...btn.gray, padding: '3px 7px', fontSize: 10 }} title="Editar portas" onClick={() => setEditingPolicy(p)}><Icon.Edit /></button>
                                )}
                                {p.adopted && (
                                  <button style={{ ...btn.base, ...btn.orange, padding: '3px 7px', fontSize: 10 }} title="Desadotar — remove do Floodgate mas mantém no cluster" onClick={() => handleUnadopt(p)}>↩ Desadotar</button>
                                )}
                                <button style={{ ...btn.base, ...btn.red, padding: '3px 7px' }} onClick={() => handleDelete(p.namespace, p.name)}><Icon.Trash /></button>
                              </>
                            )}
                          </div>
                        </div>
                        {expandedYAML === key && <LiveYAMLViewer namespace={p.namespace} name={p.name} />}
                      </div>
                    )
                  })}

                  {/* Paused policies (inline, grayed out) */}
                  {nsPaused.map(p => {
                    const key = `paused-${p.id}`
                    return (
                      <div key={p.id} style={{ borderBottom: '1px solid #f9fafb', opacity: 0.55 }}>
                        <div style={{ padding: '8px 14px 8px 20px', display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', border: '2px dashed #9ca3af', flexShrink: 0, background: 'transparent' }} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 11, fontWeight: 600, color: '#9ca3af', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {p.name}
                            </div>
                            <div style={{ fontSize: 9, color: '#d1d5db', marginTop: 1 }}>pausada · não está no cluster</div>
                          </div>
                          <span style={{ fontSize: 8, fontWeight: 700, color: '#9ca3af', background: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: 3, padding: '1px 4px', flexShrink: 0 }}>INATIVA</span>
                          <button style={{ ...btn.base, ...btn.gray, padding: '3px 7px', fontSize: 10, flexShrink: 0 }} onClick={() => toggleYAML(key)}><Icon.Eye /></button>
                        </div>
                        {expandedYAML === key && <StaticYAMLViewer yamlStr={p.policy_yaml} />}
                      </div>
                    )
                  })}
                </>
              )}
            </div>
          )
        })}

        {/* External (non-managed) policies */}
        {external.length > 0 && (
          <div style={{ borderTop: '2px solid #f1f5f9' }}>
            <button style={{ width: '100%', padding: '8px 14px', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#64748b' }} onClick={() => setShowExternal(v => !v)}>
              {showExternal ? <Icon.ChevronDown /> : <Icon.ChevronRight />}
              <span style={{ fontWeight: 600 }}>Externas (não gerenciadas)</span>
              <span style={{ fontSize: 10, color: '#94a3b8', background: '#f1f5f9', borderRadius: 10, padding: '1px 7px', marginLeft: 'auto' }}>{external.length}</span>
            </button>
            {showExternal && external.map(p => {
              const key = `ext-${p.namespace}/${p.name}`
              const isAdopting = adoptingPolicy?.namespace === p.namespace && adoptingPolicy?.name === p.name
              const canManage = !isViewer && (!canManageNamespace || canManageNamespace(p.namespace))
              return (
                <div key={key} style={{ borderBottom: '1px solid #f0f4f8', background: isAdopting ? '#f0f9ff' : '#fafafa' }}>
                  <div style={{ padding: '7px 14px 7px 20px', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#94a3b8', flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, color: '#64748b', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</div>
                      <div style={{ fontSize: 9, color: '#94a3b8' }}>{p.namespace} · {p.policy_types.join(', ')}</div>
                    </div>
                    <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                      <button style={{ ...btn.base, ...btn.gray, padding: '3px 7px', fontSize: 10 }} onClick={() => toggleYAML(key)}><Icon.Eye /></button>
                      {canManage && !isAdopting && (
                        <button style={{ ...btn.base, ...btn.blue, padding: '3px 7px', fontSize: 10 }} onClick={() => openAdopt(p)}>+ Adotar</button>
                      )}
                      {canManage && isAdopting && (
                        <button style={{ ...btn.base, ...btn.gray, padding: '3px 7px', fontSize: 10 }} onClick={() => setAdoptingPolicy(null)}>✕</button>
                      )}
                    </div>
                  </div>
                  {expandedYAML === key && <LiveYAMLViewer namespace={p.namespace} name={p.name} />}
                  {isAdopting && (
                    <div style={{ margin: '0 12px 10px', background: '#fff', border: '1px solid #bae6fd', borderRadius: 8, padding: 12 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: '#0369a1', marginBottom: 8 }}>Adotar policy no Floodgate</div>
                      <div style={{ fontSize: 10, color: '#475569', marginBottom: 6 }}>Tipo de policy (detectado automaticamente — ajuste se necessário):</div>
                      <select
                        value={adoptType}
                        onChange={e => setAdoptType(e.target.value)}
                        style={{ width: '100%', border: '1px solid #bae6fd', borderRadius: 5, padding: '4px 6px', fontSize: 10, marginBottom: 8, background: '#fff' }}
                      >
                        <option value="allow">allow (ingress de workload específico)</option>
                        <option value="allow-egress">allow-egress (egress de workload específico)</option>
                        <option value="allow-namespace">allow-namespace (ingress de namespace inteiro)</option>
                        <option value="restrict-ingress">restrict-ingress (default-deny ingress)</option>
                        <option value="restrict-egress">restrict-egress (default-deny egress)</option>
                        <option value="external">external (personalizada)</option>
                      </select>
                      <LiveYAMLViewer namespace={p.namespace} name={p.name} />
                      <div style={{ fontSize: 9, color: '#64748b', background: '#f0f9ff', border: '1px solid #e0f2fe', borderRadius: 5, padding: '5px 8px', marginTop: 8, marginBottom: 10 }}>
                        A policy será adicionada ao Floodgate com o label <code>managed-by: floodgate</code>. Ela <strong>não será recriada</strong> — apenas recebe as labels de gerenciamento. A partir daí aparecerá na lista de policies ativas e será monitorada pelo autosync.
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          style={{ ...btn.base, ...btn.blue, fontSize: 10, flex: 1, justifyContent: 'center' }}
                          onClick={confirmAdopt}
                          disabled={adopting}
                        >
                          {adopting ? 'Adotando…' : 'Confirmar adoção'}
                        </button>
                        <button style={{ ...btn.base, ...btn.gray, fontSize: 10 }} onClick={() => setAdoptingPolicy(null)}>Cancelar</button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Security tab — per-service posture ────────────────────────────────────
type ServicePosture = {
  name: string; namespace: string
  hasDenyIngress: boolean; hasDenyEgress: boolean; allowCount: number
}

function SegurancaTab({ services, policies, config, isAdmin, canManageNamespace, onRefresh }: {
  services: ServiceInfo[]; policies: NetworkPolicyInfo[]; config: AppConfig; isAdmin: boolean; canManageNamespace?: (namespace: string) => boolean; onRefresh: () => void
}) {
  const [coverageLoaded, setCoverageLoaded] = useState(false)
  const [applyingNs, setApplyingNs] = useState<string | null>(null)
  const [expandedSection, setExpandedSection] = useState<'exposed' | 'partial' | 'protected' | null>('exposed')
  const [view, setView] = useState<'services' | 'namespaces'>('services')
  const [isoNs, setIsoNs] = useState<string | null>(null)
  const [isoDirection, setIsoDirection] = useState<'ingress' | 'egress' | 'both'>('both')
  const [isoAllowIntra, setIsoAllowIntra] = useState(true)
  const [isoApplying, setIsoApplying] = useState(false)
  useEffect(() => {
    getSecurityCoverage().then(() => setCoverageLoaded(true)).catch(() => setCoverageLoaded(true))
  }, [])

  const postures: ServicePosture[] = services.map(svc => {
    const svcPolicies = policies.filter(p => p.namespace === svc.namespace && p.dst_service === svc.name)
    return {
      name: svc.name,
      namespace: svc.namespace,
      hasDenyIngress: svcPolicies.some(p => p.policy_type === 'restrict-ingress'),
      hasDenyEgress:  svcPolicies.some(p => p.policy_type === 'restrict-egress'),
      allowCount: svcPolicies.filter(p => ['allow', 'allow-egress', 'allow-namespace'].includes(p.policy_type)).length,
    }
  })

  const exposed    = postures.filter(s => !s.hasDenyIngress && !s.hasDenyEgress)
  const partial    = postures.filter(s => (s.hasDenyIngress || s.hasDenyEgress) && !(s.hasDenyIngress && s.hasDenyEgress))
  const protected_ = postures.filter(s => s.hasDenyIngress && s.hasDenyEgress)
  const total = postures.length

  async function handleApplyDeny(ns: string, direction: 'ingress' | 'egress' | 'both') {
    setApplyingNs(ns)
    try { await applyDefaultDeny(ns, direction); onRefresh() } finally { setApplyingNs(null) }
  }

  async function handleApplyAllExposed() {
    const namespaces = [...new Set(exposed.map(s => s.namespace).filter(ns => !canManageNamespace || canManageNamespace(ns)))]
    for (const ns of namespaces) {
      try { await applyDefaultDeny(ns, 'ingress') } catch { /* best-effort */ }
    }
    onRefresh()
  }

  async function handleIsolate(ns: string) {
    setIsoApplying(true)
    try {
      await isolateNamespace({ namespace: ns, direction: isoDirection, allow_intra_namespace: isoAllowIntra, allow_egress_internet: false })
      setIsoNs(null)
      onRefresh()
    } finally { setIsoApplying(false) }
  }

  // Per-namespace stats for the namespace view
  const nsList = [...new Set(services.map(s => s.namespace))].sort()
  const nsStats = nsList.map(ns => {
    const nsSvcs = services.filter(s => s.namespace === ns)
    const nsPols = policies.filter(p => p.namespace === ns)
    const withIn  = nsSvcs.filter(s => nsPols.some(p => p.dst_service === s.name && p.policy_type === 'restrict-ingress')).length
    const withOut = nsSvcs.filter(s => nsPols.some(p => p.dst_service === s.name && p.policy_type === 'restrict-egress')).length
    const total = nsSvcs.length
    const fullyProtected = withIn === total && withOut === total
    const anyProtected   = withIn > 0 || withOut > 0
    return { ns, total, withIn, withOut, fullyProtected, anyProtected }
  })

  if (!coverageLoaded) {
    return <div style={{ padding: 24, textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>Analisando cobertura…</div>
  }

  if (total === 0) {
    return <div style={{ padding: 24, textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>Nenhum serviço encontrado.</div>
  }

  const sections = [
    { id: 'exposed'    as const, label: 'Expostos',               sublabel: 'Sem nenhuma restrição',           color: '#dc2626', bg: '#fef2f2', border: '#fecaca', items: exposed },
    { id: 'partial'    as const, label: 'Parcialmente protegidos', sublabel: 'Apenas ingress ou egress restrito', color: '#d97706', bg: '#fffbeb', border: '#fde68a', items: partial },
    { id: 'protected'  as const, label: 'Totalmente protegidos',   sublabel: 'Ingress e egress com default-deny', color: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0', items: protected_ },
  ]

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', borderBottom: '1px solid #f1f5f9', flexShrink: 0 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 8 }}>
          {[
            { count: exposed.length,    label: 'Expostos',   color: '#dc2626', bg: '#fef2f2', border: '#fecaca' },
            { count: partial.length,    label: 'Parciais',   color: '#d97706', bg: '#fffbeb', border: '#fde68a' },
            { count: protected_.length, label: 'Protegidos', color: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0' },
          ].map(card => (
            <div key={card.label} style={{ background: card.bg, border: `1px solid ${card.border}`, borderRadius: 8, padding: '8px 10px', textAlign: 'center' }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: card.color, lineHeight: 1 }}>{card.count}</div>
              <div style={{ fontSize: 9, fontWeight: 600, color: card.color, marginTop: 2, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{card.label}</div>
              <div style={{ fontSize: 9, color: '#94a3b8', marginTop: 2 }}>de {total}</div>
            </div>
          ))}
        </div>
        {config.auto_default_deny_enabled && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: '#10b981', background: '#f0fdf4', borderRadius: 6, padding: '5px 8px', marginBottom: 8 }}>
            <Icon.Shield />
            Auto default-deny ativo ({config.auto_default_deny_direction})
          </div>
        )}
        {/* View toggle */}
        <div style={{ display: 'flex', background: '#f1f5f9', borderRadius: 6, padding: 2, gap: 2 }}>
          {(['services', 'namespaces'] as const).map(v => (
            <button key={v} onClick={() => setView(v)}
              style={{ flex: 1, border: 'none', borderRadius: 5, padding: '4px 0', fontSize: 10, fontWeight: 600, cursor: 'pointer',
                background: view === v ? 'white' : 'transparent',
                color: view === v ? '#2563eb' : '#64748b',
                boxShadow: view === v ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
              }}>
              {v === 'services' ? 'Por serviço' : 'Por namespace'}
            </button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>

        {/* ── Namespace isolation view ── */}
        {view === 'namespaces' && nsStats.map(({ ns, total, withIn, withOut, fullyProtected, anyProtected }) => {
          const color  = fullyProtected ? '#16a34a' : anyProtected ? '#d97706' : '#dc2626'
          const bg     = fullyProtected ? '#f0fdf4'  : anyProtected ? '#fffbeb'  : '#fef2f2'
          const border = fullyProtected ? '#bbf7d0'  : anyProtected ? '#fde68a'  : '#fecaca'
          const isOpen = isoNs === ns
          return (
            <div key={ns} style={{ borderBottom: `1px solid ${border}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '9px 14px', background: bg }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ns}</div>
                  <div style={{ fontSize: 9, color: '#94a3b8', marginTop: 2 }}>
                    {total} svc · {withIn}/{total} IN · {withOut}/{total} OUT
                  </div>
                </div>
                {isAdmin && (!canManageNamespace || canManageNamespace(ns)) && (
                  <button
                    style={{ ...btn.base, ...(isOpen ? btn.gray : btn.red), fontSize: 9, padding: '3px 8px', flexShrink: 0 }}
                    onClick={() => { setIsoNs(isOpen ? null : ns); setIsoDirection('both'); setIsoAllowIntra(true) }}>
                    {isOpen ? 'Cancelar' : 'Isolar'}
                  </button>
                )}
              </div>
              {isOpen && (
                <div style={{ padding: '10px 14px', background: '#fafafa', borderTop: '1px solid #f1f5f9' }}>
                  <div style={{ marginBottom: 8 }}>
                    <label style={{ display: 'block', fontSize: 10, fontWeight: 600, color: '#475569', marginBottom: 3 }}>Direção do bloqueio</label>
                    <select value={isoDirection} onChange={e => setIsoDirection(e.target.value as typeof isoDirection)}
                      style={{ width: '100%', border: '1px solid #cbd5e1', borderRadius: 5, padding: '5px 8px', fontSize: 11 }}>
                      <option value="ingress">Ingress only</option>
                      <option value="egress">Egress only</option>
                      <option value="both">Ingress + Egress</option>
                    </select>
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, cursor: 'pointer', fontSize: 10, fontWeight: 600, color: '#475569' }}>
                    <input type="checkbox" checked={isoAllowIntra} onChange={e => setIsoAllowIntra(e.target.checked)} style={{ accentColor: '#3b82f6' }} />
                    Permitir tráfego interno ao namespace
                  </label>
                  <div style={{ fontSize: 10, color: '#c2410c', background: '#fff7ed', borderRadius: 5, padding: '5px 8px', marginBottom: 8 }}>
                    ⚠ Aplica default-deny em {total} serviço(s). Serviços sem allow explícito ficarão inacessíveis.
                  </div>
                  <button
                    style={{ ...btn.base, ...btn.red, width: '100%', justifyContent: 'center', opacity: isoApplying ? 0.6 : 1 }}
                    disabled={isoApplying}
                    onClick={() => handleIsolate(ns)}>
                    <Icon.Shield /> {isoApplying ? 'Aplicando…' : `Isolar namespace ${ns}`}
                  </button>
                </div>
              )}
            </div>
          )
        })}
        {view === 'namespaces' && nsStats.length === 0 && (
          <div style={{ padding: 24, textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>Nenhum namespace encontrado.</div>
        )}

        {/* ── Per-service view ── */}
        {view === 'services' && sections.map(sec => (
          <div key={sec.id}>
            <button onClick={() => setExpandedSection(prev => prev === sec.id ? null : sec.id)}
              style={{ width: '100%', padding: '8px 14px', background: sec.bg, border: 'none', borderBottom: `1px solid ${sec.border}`, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left' }}>
              {expandedSection === sec.id ? <Icon.ChevronDown /> : <Icon.ChevronRight />}
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: sec.color }}>{sec.label}</div>
                <div style={{ fontSize: 9, color: '#94a3b8', marginTop: 1 }}>{sec.sublabel}</div>
              </div>
              <span style={{ fontSize: 11, fontWeight: 800, color: sec.color }}>{sec.items.length}</span>
            </button>

            {expandedSection === sec.id && (
              <>
                {sec.id === 'exposed' && isAdmin && sec.items.some(s => !canManageNamespace || canManageNamespace(s.namespace)) && (
                  <div style={{ padding: '8px 14px', background: '#fff5f5', borderBottom: '1px solid #fecaca' }}>
                    <button style={{ ...btn.base, ...btn.red, fontSize: 10, width: '100%', justifyContent: 'center' }} onClick={handleApplyAllExposed}>
                      <Icon.Shield /> Aplicar default-deny ingress em todos expostos
                    </button>
                  </div>
                )}
                {sec.items.map(svc => {
                  const isApplying = applyingNs === svc.namespace
                  const missingIn = !svc.hasDenyIngress
                  const missingEg = !svc.hasDenyEgress
                  return (
                    <div key={`${svc.namespace}/${svc.name}`} style={{ padding: '8px 14px 8px 22px', borderBottom: '1px solid #f9fafb', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: '#1e293b' }}>{svc.name}</div>
                        <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
                          <span style={{ fontSize: 9, fontWeight: 600, color: svc.hasDenyIngress ? '#16a34a' : '#dc2626' }}>{svc.hasDenyIngress ? '✓' : '✗'} IN</span>
                          <span style={{ fontSize: 9, fontWeight: 600, color: svc.hasDenyEgress ? '#16a34a' : '#dc2626' }}>{svc.hasDenyEgress ? '✓' : '✗'} OUT</span>
                          {svc.allowCount > 0 && <span style={{ fontSize: 9, color: '#94a3b8' }}>{svc.allowCount} allow</span>}
                        </div>
                      </div>
                      {isAdmin && (!canManageNamespace || canManageNamespace(svc.namespace)) && (missingIn || missingEg) && (
                        <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
                          {missingIn && <button style={{ ...btn.base, ...btn.red, padding: '2px 6px', fontSize: 9, opacity: isApplying ? 0.6 : 1 }} onClick={() => handleApplyDeny(svc.namespace, 'ingress')} disabled={isApplying}>+IN</button>}
                          {missingEg && <button style={{ ...btn.base, ...btn.orange, padding: '2px 6px', fontSize: 9, opacity: isApplying ? 0.6 : 1 }} onClick={() => handleApplyDeny(svc.namespace, 'egress')} disabled={isApplying}>+OUT</button>}
                        </div>
                      )}
                    </div>
                  )
                })}
                {sec.items.length === 0 && (
                  <div style={{ padding: '12px 14px', textAlign: 'center', fontSize: 11, color: '#94a3b8' }}>
                    {sec.id === 'protected' ? 'Nenhum serviço totalmente protegido ainda.' : 'Nenhum.'}
                  </div>
                )}
              </>
            )}
          </div>
        ))}

      </div>
    </div>
  )
}

// ─── Aprovacoes tab ────────────────────────────────────────────────────────
const ROLE_BADGE: Record<string, { bg: string; color: string; label: string }> = {
  admin:    { bg: '#eff6ff', color: '#185FA5', label: 'admin' },
  ns_admin: { bg: '#f5f3ff', color: '#6d28d9', label: 'ns_admin' },
  viewer:   { bg: '#f1f5f9', color: '#475569', label: 'viewer' },
  audit:    { bg: '#fff7ed', color: '#c2410c', label: 'audit' },
}

function ApprovacoesTab({ currentUser, config, onRefresh, pendingApprovals }: { currentUser: User | null; config: AppConfig; onRefresh: () => void; pendingApprovals: ApprovalRequest[] }) {
  const [history, setHistory] = useState<ApprovalRequest[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [loading, setLoading] = useState(false)
  const [approverFilter, setApproverFilter] = useState('')
  const [userRoleMap, setUserRoleMap] = useState<Record<string, string>>({})
  const [yamlOpen, setYamlOpen] = useState<string | null>(null)
  const [yamlContent, setYamlContent] = useState<Record<string, string>>({})
  const [applyErrors, setApplyErrors] = useState<Record<string, string>>({})

  const loadHistory = useCallback(async () => {
    if (!showHistory) return
    setLoading(true)
    try {
      const [applied, rejected] = await Promise.all([getApprovalRequests('applied'), getApprovalRequests('rejected')])
      setHistory([...applied, ...rejected].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()))
    } finally { setLoading(false) }
  }, [showHistory])

  useEffect(() => { loadHistory() }, [loadHistory])

  const isAdmin = currentUser?.role === 'admin'
  const isViewer = currentUser?.role === 'viewer'

  // Fetch user roles for vote badges (admin only)
  useEffect(() => {
    if (!isAdmin) return
    listUsers().then(users => {
      const map: Record<string, string> = {}
      for (const u of users) map[u.username] = u.role
      setUserRoleMap(map)
    }).catch(() => {})
  }, [isAdmin])

  const hasVoted = (req: ApprovalRequest) => currentUser ? req.votes.some(v => v.username === currentUser.username) : false
  const canApply = (req: ApprovalRequest) => req.approve_count >= req.approvals_required && req.reject_count === 0
  const canVote  = (req: ApprovalRequest) => {
    if (!currentUser) return false
    if (currentUser.role === 'admin') return true
    const allowed = req.allowed_approvers
    return allowed.length === 0 || allowed.some(a => a.id === currentUser.id)
  }

  if (!config.approval_enabled) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, gap: 10 }}>
        <Icon.Clock />
        <div style={{ fontSize: 12, color: '#64748b', textAlign: 'center' }}>Workflow de aprovação desativado.<br/>Ative em Config.</div>
      </div>
    )
  }

  const rawList = showHistory ? history : pendingApprovals
  const displayList = approverFilter
    ? rawList.filter(req => {
        const q = approverFilter.toLowerCase()
        return req.allowed_approvers.some(a => a.username.toLowerCase().includes(q)) ||
               req.created_by_username.toLowerCase().includes(q)
      })
    : rawList

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '8px 14px', borderBottom: '1px solid #f1f5f9', flexShrink: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <span style={{ fontSize: 11, color: '#94a3b8' }}>{loading ? '…' : showHistory ? `${history.length} no histórico` : `${pendingApprovals.length} pendente(s)`}</span>
          <div style={{ display: 'flex', gap: 5 }}>
            <button style={{ ...btn.base, ...btn.gray, fontSize: 10 }} onClick={() => setShowHistory(v => !v)}>{showHistory ? 'Pendentes' : 'Histórico'}</button>
            <button style={{ ...btn.base, ...btn.gray, fontSize: 10 }} onClick={() => { onRefresh(); loadHistory() }}>↻</button>
          </div>
        </div>
        {/* Viewer badge */}
        {isViewer && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 6, padding: '5px 8px', marginBottom: 6 }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#185FA5" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <span style={{ fontSize: 10, color: '#185FA5', fontWeight: 600 }}>Você é viewer — pode aprovar pedidos nos quais estiver listado como aprovador.</span>
          </div>
        )}
        {/* Approver filter */}
        <input
          type="text"
          placeholder="Filtrar por aprovador ou criador…"
          value={approverFilter}
          onChange={e => setApproverFilter(e.target.value)}
          style={{ width: '100%', border: '1px solid #e2e8f0', borderRadius: 6, padding: '5px 8px', fontSize: 11, outline: 'none', boxSizing: 'border-box' }}
        />
        {approverFilter && (
          <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 3 }}>
            {displayList.length} resultado(s)
            <button onClick={() => setApproverFilter('')} style={{ marginLeft: 6, background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 10 }}>✕ limpar</button>
          </div>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {displayList.length === 0 && !loading && (
          <div style={{ padding: 24, textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>
            {approverFilter ? `Nenhum resultado para "${approverFilter}".` : showHistory ? 'Nenhum histórico.' : 'Nenhuma solicitação pendente.'}
          </div>
        )}
        {displayList.map(req => {
          const d = req.draft_data
          const voted      = hasVoted(req)
          const applicable = canApply(req)
          const allowed    = canVote(req)
          const restricted = req.allowed_approvers.length > 0
          const pct = Math.min(100, req.approvals_required > 0 ? (req.approve_count / req.approvals_required) * 100 : 0)
          const barColor = req.reject_count > 0 ? '#dc2626' : applicable ? '#10b981' : '#3b82f6'
          return (
            <div key={req.id} style={{ borderBottom: '1px solid #f9fafb', padding: '10px 14px' }}>
              {/* Route */}
              <div style={{ fontSize: 11, marginBottom: 3 }}>
                <span style={{ fontWeight: 600, color: '#2563eb' }}>{d.src_namespace}/{d.src_workload}</span>
                <span style={{ color: '#94a3b8', margin: '0 5px' }}>→</span>
                <span style={{ fontWeight: 600, color: '#16a34a' }}>{d.dst_namespace}/{d.dst_service}:{d.dst_ports.map(p => p.port).join(',')}</span>
              </div>
              <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 6 }}>
                Por {req.created_by_username} · {new Date(req.created_at).toLocaleDateString('pt-BR')}
              </div>

              {/* Allowed approvers row */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 6, flexWrap: 'wrap' }}>
                {restricted ? (
                  <>
                    <span style={{ fontSize: 9, color: '#94a3b8', fontWeight: 600 }}>Aprovadores:</span>
                    {req.allowed_approvers.map(a => {
                      const isMe = a.id === currentUser?.id
                      return (
                        <span key={a.id} style={{ fontSize: 9, padding: '1px 5px', borderRadius: 10, fontWeight: 600, background: isMe ? '#eff6ff' : '#f1f5f9', color: isMe ? '#185FA5' : '#475569', border: `1px solid ${isMe ? '#bfdbfe' : '#e2e8f0'}` }}>
                          {isMe ? '→ ' : ''}{a.username}
                        </span>
                      )
                    })}
                  </>
                ) : (
                  <span style={{ fontSize: 9, color: '#94a3b8' }}>Qualquer usuário pode votar</span>
                )}
              </div>

              {/* Quorum progress bar */}
              {req.status === 'pending' && (
                <div style={{ marginBottom: 6 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
                    <span style={{ fontSize: 9, fontWeight: 700, color: barColor }}>
                      {req.reject_count > 0 ? '✗ Rejeitado' : applicable ? '✓ Aprovações suficientes' : `${req.approve_count} de ${req.approvals_required} aprovações`}
                    </span>
                    <span style={{ fontSize: 9, color: '#94a3b8' }}>{req.approve_count}/{req.approvals_required}</span>
                  </div>
                  <div style={{ height: 4, borderRadius: 2, background: '#e2e8f0', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${pct}%`, background: barColor, borderRadius: 2, transition: 'width 0.3s' }} />
                  </div>
                  {/* Auto-apply error banner */}
                  {applyErrors[req.id] && (
                    <div style={{ marginTop: 5, padding: '5px 8px', background: '#fff1f2', border: '1px solid #fecdd3', borderRadius: 6, fontSize: 10, color: '#dc2626' }}>
                      <strong>Erro ao aplicar automaticamente:</strong><br />{applyErrors[req.id]}
                    </div>
                  )}
                  {/* Quorum met but not applied yet (other user's perspective before SSE arrives) */}
                  {applicable && !applyErrors[req.id] && (
                    <div style={{ marginTop: 4, fontSize: 9, color: '#6b7280' }}>Aplicação automática em andamento…</div>
                  )}
                </div>
              )}
              {req.status !== 'pending' && (
                <div style={{ marginBottom: 6 }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: req.status === 'applied' ? '#10b981' : '#dc2626' }}>
                    {req.status === 'applied' ? '✓ Aplicado' : '✗ Rejeitado'}
                  </span>
                </div>
              )}

              {/* Votes */}
              {req.votes.length > 0 && (
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
                  {req.votes.map(v => {
                    const role = userRoleMap[v.username]
                    const rb = role ? ROLE_BADGE[role] : null
                    return (
                      <span key={v.id} style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 9, padding: '2px 6px', borderRadius: 10, fontWeight: 600, background: v.decision === 'approve' ? '#f0fdf4' : '#fff1f2', color: v.decision === 'approve' ? '#16a34a' : '#dc2626', border: `1px solid ${v.decision === 'approve' ? '#bbf7d0' : '#fecdd3'}` }}>
                        {v.decision === 'approve' ? '✓' : '✗'} {v.username}
                        {rb && <span style={{ fontSize: 8, background: rb.bg, color: rb.color, borderRadius: 3, padding: '0 3px', marginLeft: 2 }}>{rb.label}</span>}
                      </span>
                    )
                  })}
                </div>
              )}

              {/* YAML preview */}
              <div style={{ marginBottom: 4 }}>
                <button
                  style={{ ...btn.base, fontSize: 10, background: yamlOpen === req.id ? '#f1f5f9' : 'transparent', border: '1px solid #e2e8f0', color: '#475569', gap: 4 }}
                  onClick={async () => {
                    if (yamlOpen === req.id) { setYamlOpen(null); return }
                    setYamlOpen(req.id)
                    if (!yamlContent[req.id]) {
                      try {
                        const yml = await getApprovalRequestYAML(req.id)
                        setYamlContent(prev => ({ ...prev, [req.id]: yml }))
                      } catch {
                        setYamlContent(prev => ({ ...prev, [req.id]: '# Erro ao carregar YAML' }))
                      }
                    }
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                  {yamlOpen === req.id ? 'Ocultar YAML' : 'Ver YAML'}
                </button>
                {yamlOpen === req.id && (
                  <pre style={{
                    marginTop: 6, padding: '8px 10px', background: '#0f172a', color: '#e2e8f0',
                    borderRadius: 6, fontSize: 9.5, lineHeight: 1.6, overflowX: 'auto',
                    fontFamily: 'ui-monospace, monospace', whiteSpace: 'pre', maxHeight: 220,
                  }}>
                    {yamlContent[req.id] ?? '⠋ Carregando…'}
                  </pre>
                )}
              </div>

              {/* Actions */}
              {req.status === 'pending' && (
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                  {allowed ? (
                    <>
                      <button style={{ ...btn.base, ...btn.green, fontSize: 10, opacity: voted ? 0.5 : 1 }} onClick={async () => {
                        const result = await voteApprovalRequest(req.id, 'approve')
                        if (result.auto_apply_error) setApplyErrors(prev => ({ ...prev, [req.id]: result.auto_apply_error! }))
                        onRefresh()
                      }} disabled={voted}><Icon.Check /> Aprovar</button>
                      <button style={{ ...btn.base, ...btn.red, fontSize: 10, opacity: voted ? 0.5 : 1 }} onClick={async () => { await voteApprovalRequest(req.id, 'reject'); onRefresh() }} disabled={voted}>Rejeitar</button>
                    </>
                  ) : (
                    <span style={{ fontSize: 10, color: '#94a3b8', fontStyle: 'italic' }}>Você não está na lista de aprovadores</span>
                  )}
                  {(currentUser?.username === req.created_by_username || isAdmin) && <button style={{ ...btn.base, ...btn.gray, fontSize: 10 }} onClick={() => cancelApprovalRequest(req.id).then(onRefresh)}>Cancelar</button>}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Config tab ───────────────────────────────────────────────────────────
function ConfigTab({ config, onSave }: { config: AppConfig; onSave: (c: AppConfig) => Promise<void> }) {
  const [local, setLocal] = useState<AppConfig>(config)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<AutosyncStatus['last_result']>(null)
  const [autosyncStatus, setAutosyncStatus] = useState<AutosyncStatus | null>(null)
  const [showMissing, setShowMissing] = useState(false)
  const [expandedPolicy, setExpandedPolicy] = useState<string | null>(null)
  const [allUsers, setAllUsers] = useState<User[]>([])
  const [approverSearch, setApproverSearch] = useState('')
  useEffect(() => { setLocal(config) }, [config])
  useEffect(() => { listUsers().then(setAllUsers).catch(() => {}) }, [])
  useEffect(() => {
    function refresh() {
      getAutosyncStatus().then(s => { setAutosyncStatus(s); setSyncResult(s.last_result) }).catch(() => {})
    }
    refresh()
    const id = setInterval(refresh, 15_000)
    return () => clearInterval(id)
  }, [])

  function getErrors(): string[] {
    const errs: string[] = []
    if (local.approval_enabled) {
      if (local.approval_required_count < 1)
        errs.push('Aprovações necessárias deve ser pelo menos 1.')
      if (
        local.approval_default_approvers.length > 0 &&
        local.approval_required_count > local.approval_default_approvers.length
      )
        errs.push(
          `Aprovações necessárias (${local.approval_required_count}) não pode ser maior que o número de aprovadores padrão selecionados (${local.approval_default_approvers.length}).`
        )
    }
    if (local.autosync_enabled && local.autosync_interval_s < 30)
      errs.push('Intervalo do autosync deve ser de pelo menos 30 segundos.')
    const watchedSet = new Set(local.watched_namespaces)
    const overlap = local.ignored_namespaces.filter(ns => watchedSet.has(ns))
    if (overlap.length > 0)
      errs.push(`Namespace(s) "${overlap.join(', ')}" estão em monitorados E ignorados ao mesmo tempo.`)
    return errs
  }

  async function handleSave() {
    if (getErrors().length > 0) return
    setSaving(true)
    try { await onSave(local); setSaved(true); setTimeout(() => setSaved(false), 2000) } finally { setSaving(false) }
  }

  async function handleSync() {
    setSyncing(true)
    try {
      const result = await triggerAutosync()
      setSyncResult(result)
      setAutosyncStatus(prev => prev ? { ...prev, drift: { missing: [], timestamp: result?.timestamp ?? new Date().toISOString() } } : prev)
    } finally {
      setSyncing(false)
    }
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
      <div style={{ marginBottom: 14 }}>
        <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#475569', marginBottom: 4 }}>Namespaces ignorados (vírgula)</label>
        <textarea value={local.ignored_namespaces.join(', ')} onChange={e => setLocal(p => ({ ...p, ignored_namespaces: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }))}
          rows={3} style={{ width: '100%', border: '1px solid #cbd5e1', borderRadius: 6, padding: '6px 10px', fontSize: 11, resize: 'vertical', boxSizing: 'border-box', fontFamily: 'ui-monospace, monospace' }} />
      </div>
      <div style={{ marginBottom: 14 }}>
        <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#475569', marginBottom: 4 }}>Namespaces monitorados (vazio = todos)</label>
        <textarea value={local.watched_namespaces.join(', ')} onChange={e => setLocal(p => ({ ...p, watched_namespaces: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }))}
          rows={2} style={{ width: '100%', border: '1px solid #cbd5e1', borderRadius: 6, padding: '6px 10px', fontSize: 11, resize: 'vertical', boxSizing: 'border-box', fontFamily: 'ui-monospace, monospace' }} />
      </div>
      <div style={{ marginBottom: 14, borderTop: '1px solid #f1f5f9', paddingTop: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#475569', marginBottom: 10 }}>Workflow de aprovação</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <ToggleSwitch on={local.approval_enabled} onChange={v => setLocal(p => ({ ...p, approval_enabled: v }))} />
          <span style={{ fontSize: 11, color: '#475569' }}>Exigir aprovação antes de aplicar</span>
        </div>
        {local.approval_enabled && (
          <div style={{ paddingLeft: 46, marginBottom: 8 }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#475569', marginBottom: 4 }}>Aprovações necessárias</label>
            {(() => {
              const approverCount = local.approval_default_approvers.length
              const countInvalid = approverCount > 0 && local.approval_required_count > approverCount
              return (
                <>
                  <input type="number" min={1} max={10} value={local.approval_required_count}
                    onChange={e => setLocal(p => ({ ...p, approval_required_count: Math.min(10, Math.max(1, parseInt(e.target.value) || 1)) }))}
                    style={{ width: 70, border: `1px solid ${countInvalid ? '#f87171' : '#cbd5e1'}`, borderRadius: 6, padding: '5px 8px', fontSize: 11, background: countInvalid ? '#fef2f2' : undefined }} />
                  {countInvalid && (
                    <span style={{ marginLeft: 8, fontSize: 10, color: '#b91c1c' }}>
                      máx {approverCount} (aprovadores selecionados)
                    </span>
                  )}
                </>
              )
            })()}

            <div style={{ marginTop: 12 }}>
              <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#475569', marginBottom: 6 }}>
                Aprovadores padrão
                {local.approval_default_approvers.length > 0 && (
                  <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: '#fff', background: '#185FA5', borderRadius: 10, padding: '1px 7px' }}>
                    {local.approval_default_approvers.length}
                  </span>
                )}
              </label>
              <div style={{ fontSize: 10, color: '#64748b', marginBottom: 6 }}>
                Estes usuários serão pré-selecionados como aprovadores em todos os novos rascunhos.
              </div>
              <input
                placeholder="Buscar usuário…"
                value={approverSearch}
                onChange={e => setApproverSearch(e.target.value)}
                style={{ width: '100%', border: '1px solid #cbd5e1', borderRadius: 5, padding: '4px 8px', fontSize: 10, marginBottom: 4, boxSizing: 'border-box' }}
              />
              <div style={{ maxHeight: 140, overflowY: 'auto', border: '1px solid #e2e8f0', borderRadius: 6, background: '#fff' }}>
                {allUsers
                  .filter(u => !approverSearch || u.username.toLowerCase().includes(approverSearch.toLowerCase()))
                  .map(u => {
                    const isSelected = (local.approval_default_approvers ?? []).some(a => a.id === u.id)
                    return (
                      <label key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 9px', cursor: 'pointer', borderBottom: '1px solid #f1f5f9', background: isSelected ? '#eff6ff' : 'transparent' }}>
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => {
                            setLocal(p => {
                              const current = p.approval_default_approvers ?? []
                              const next = isSelected
                                ? current.filter(a => a.id !== u.id)
                                : [...current, { id: u.id, username: u.username }]
                              return { ...p, approval_default_approvers: next }
                            })
                          }}
                          style={{ accentColor: '#185FA5' }}
                        />
                        <span style={{ fontSize: 10, fontWeight: 600, color: '#1e293b', flex: 1 }}>{u.username}</span>
                        <span style={{ fontSize: 9, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.5 }}>{u.role}</span>
                      </label>
                    )
                  })}
                {allUsers.filter(u => !approverSearch || u.username.toLowerCase().includes(approverSearch.toLowerCase())).length === 0 && (
                  <div style={{ padding: '8px 10px', fontSize: 10, color: '#94a3b8', textAlign: 'center' }}>Nenhum usuário encontrado.</div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
      <div style={{ marginBottom: 14, borderTop: '1px solid #f1f5f9', paddingTop: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#475569', marginBottom: 10 }}>Default-deny automático</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <ToggleSwitch on={local.auto_default_deny_enabled} onChange={v => setLocal(p => ({ ...p, auto_default_deny_enabled: v }))} />
          <span style={{ fontSize: 11, color: '#475569' }}>Aplicar em namespaces sem cobertura</span>
        </div>
        {local.auto_default_deny_enabled && (
          <div style={{ paddingLeft: 46, marginBottom: 8 }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#475569', marginBottom: 4 }}>Direção</label>
            <select value={local.auto_default_deny_direction} onChange={e => setLocal(p => ({ ...p, auto_default_deny_direction: e.target.value as AppConfig['auto_default_deny_direction'] }))}
              style={{ border: '1px solid #cbd5e1', borderRadius: 6, padding: '5px 8px', fontSize: 11 }}>
              <option value="ingress">Ingress only</option>
              <option value="egress">Egress only</option>
              <option value="both">Ambos</option>
            </select>
          </div>
        )}
        <div style={{ fontSize: 10, color: '#94a3b8', background: '#f8fafc', borderRadius: 6, padding: '8px 10px', lineHeight: 1.5 }}>
          O sistema aplica deny automaticamente a cada polling (15s) quando habilitado.
        </div>
      </div>
      <div style={{ marginBottom: 14, borderTop: '1px solid #f1f5f9', paddingTop: 14 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#475569', marginBottom: 10 }}>Autosync</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <ToggleSwitch on={local.autosync_enabled} onChange={v => setLocal(p => ({ ...p, autosync_enabled: v }))} />
          <span style={{ fontSize: 11, color: '#475569' }}>Restaurar policies removidas externamente</span>
        </div>
        {local.autosync_enabled && (
          <div style={{ paddingLeft: 46, marginBottom: 8 }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#475569', marginBottom: 4 }}>Intervalo (segundos)</label>
            <input type="number" min={30} max={3600} value={local.autosync_interval_s}
              onChange={e => setLocal(p => ({ ...p, autosync_interval_s: Math.min(3600, Math.max(30, parseInt(e.target.value) || 60)) }))}
              style={{ width: 80, border: '1px solid #cbd5e1', borderRadius: 6, padding: '5px 8px', fontSize: 11 }} />
          </div>
        )}

        {/* Status card — always visible, refreshes every 15 s */}
        {(() => {
          const missing = autosyncStatus?.drift?.missing ?? []
          const total = autosyncStatus?.desired_count ?? 0
          const ts = autosyncStatus?.drift?.timestamp
          const hasDrift = missing.length > 0
          return (
            <div style={{ marginBottom: 8, background: hasDrift ? '#fef2f2' : '#f0fdf4', border: `1px solid ${hasDrift ? '#fecaca' : '#bbf7d0'}`, borderRadius: 6, padding: '8px 10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: hasDrift ? '#dc2626' : '#16a34a' }}>
                  {hasDrift ? `⚠ ${missing.length} não sincronizada(s)` : `✓ Tudo sincronizado`}
                  {total > 0 && <span style={{ fontWeight: 400, color: '#64748b' }}> · {total} rastreadas</span>}
                </div>
                {ts && <span style={{ fontSize: 9, color: '#94a3b8' }}>atualizado {new Date(ts).toLocaleTimeString()}</span>}
              </div>
              {hasDrift && (
                <div style={{ fontSize: 9.5, color: '#64748b', marginBottom: 4 }}>
                  {local.autosync_enabled ? 'Será restaurado no próximo ciclo.' : 'Habilite o autosync ou clique em "Forçar sync" para restaurar.'}
                </div>
              )}
              <button
                onClick={() => setShowMissing(v => !v)}
                disabled={missing.length === 0}
                style={{ ...btn.base, background: 'transparent', border: `1px solid ${hasDrift ? '#fecaca' : '#bbf7d0'}`, color: hasDrift ? '#dc2626' : '#16a34a', padding: '3px 9px', fontSize: 9.5, borderRadius: 4, opacity: missing.length === 0 ? 0.4 : 1 }}>
                {showMissing ? 'Ocultar' : `Ver não sincronizadas (${missing.length})`}
              </button>

              {showMissing && missing.length > 0 && (
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {missing.map(p => {
                    const key = `${p.namespace}/${p.name}`
                    return (
                      <div key={key} style={{ background: '#fff1f2', border: '1px solid #fecaca', borderRadius: 5, padding: '6px 8px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <span style={{ fontSize: 9.5, fontFamily: 'ui-monospace, monospace', color: '#b91c1c' }}>{key}</span>
                          {p.policy_yaml && (
                            <button
                              onClick={() => setExpandedPolicy(prev => prev === key ? null : key)}
                              style={{ ...btn.base, background: 'transparent', border: '1px solid #fecaca', color: '#dc2626', padding: '1px 6px', fontSize: 9, borderRadius: 3 }}>
                              {expandedPolicy === key ? 'Ocultar YAML' : 'Ver YAML'}
                            </button>
                          )}
                        </div>
                        {expandedPolicy === key && p.policy_yaml && (
                          <div style={{ marginTop: 6 }}>
                            <StaticYAMLViewer yamlStr={p.policy_yaml} />
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })()}

        <div style={{ fontSize: 10, color: '#94a3b8', background: '#f8fafc', borderRadius: 6, padding: '8px 10px', lineHeight: 1.5, marginBottom: 8 }}>
          Monitoramento de drift roda a cada 15s. Correção automática só ocorre se o autosync estiver ativo.
        </div>
        <button
          onClick={handleSync} disabled={syncing}
          style={{ ...btn.base, ...btn.blue, width: '100%', justifyContent: 'center', padding: '7px', fontSize: 11 }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
          </svg>
          {syncing ? 'Sincronizando…' : '↺ Forçar sync agora'}
        </button>
        {syncResult && (
          <div style={{ marginTop: 6, fontSize: 9.5, color: '#94a3b8', padding: '4px 8px' }}>
            Última execução:{' '}
            {syncResult.seeded > 0
              ? `${syncResult.seeded} importadas`
              : syncResult.fixed > 0
                ? `${syncResult.fixed} restauradas · ${syncResult.checked} verificadas`
                : `tudo em ordem · ${syncResult.checked} verificadas`}
            {' '}· {new Date(syncResult.timestamp).toLocaleTimeString()}
          </div>
        )}
      </div>
      {(() => {
        const errs = getErrors()
        return (
          <>
            {errs.length > 0 && (
              <div style={{ marginBottom: 8, padding: '8px 10px', background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 6 }}>
                {errs.map((e, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 5, fontSize: 10, color: '#b91c1c', lineHeight: 1.5 }}>
                    <span style={{ flexShrink: 0, marginTop: 1 }}>⚠</span>
                    <span>{e}</span>
                  </div>
                ))}
              </div>
            )}
            <button
              style={{ ...btn.base, ...(saved ? btn.green : errs.length > 0 ? btn.red : btn.gray), width: '100%', justifyContent: 'center', padding: '8px', opacity: saving || errs.length > 0 ? 0.6 : 1, cursor: errs.length > 0 ? 'not-allowed' : 'pointer' }}
              onClick={handleSave}
              disabled={saving || errs.length > 0}
              title={errs.length > 0 ? errs[0] : undefined}
            >
              {saving ? 'Salvando…' : saved ? '✓ Salvo' : errs.length > 0 ? '⚠ Corrija os erros para salvar' : 'Salvar configurações'}
            </button>
          </>
        )
      })()}
    </div>
  )
}

// ─── Forbidden fallback ───────────────────────────────────────────────────
function Forbidden() {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', fontSize: 12, padding: 24, textAlign: 'center', gap: 8 }}>
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" strokeWidth="1.5"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>
      Permissão negada.<br/>Seu perfil não tem acesso a esta seção.
    </div>
  )
}

// ─── Tab label map ────────────────────────────────────────────────────────
const TAB_LABELS: Record<Tab, string> = {
  namespaces: 'Namespaces',
  drafts:     'Rascunhos',
  policies:   'Policies',
  aprovacoes: 'Aprovações',
  seguranca:  'Segurança',
  config:     'Config',
}

// ─── Main panel ───────────────────────────────────────────────────────────
interface Props {
  currentUser: User | null; allNamespaces: string[]; services: ServiceInfo[]
  policies: NetworkPolicyInfo[]; allPolicies: NetworkPolicyInfo[]; drafts: Draft[]
  visibleNamespaces: Set<string>; config: AppConfig; configLoaded: boolean
  pendingApprovals?: ApprovalRequest[]
  requestTab?: 'aprovacoes' | 'drafts' | null
  onTabOpened?: () => void
  openPasswordModal?: boolean
  onPasswordModalClosed?: () => void
  onToggleNamespace: (ns: string) => void; onRemoveDraft: (id: string) => void
  onAddDraft: (d: Omit<Draft, 'id'>) => void
  onApplyDraft: (draft: Draft, allowedApprovers?: Array<{ id: string; username: string }>) => Promise<void>; onApplyAllDrafts: () => Promise<void>
  onDiscardAllDrafts: () => void; onUpdateDraftPort: (id: string, ports: Draft['dst_ports']) => void
  onPoliciesChanged: () => void; onSaveConfig: (c: AppConfig) => Promise<void>
}

export default function RightPanel({
  currentUser, allNamespaces, services, policies, allPolicies, drafts, visibleNamespaces, config, configLoaded,
  pendingApprovals = [], requestTab, onTabOpened, openPasswordModal, onPasswordModalClosed,
  onToggleNamespace, onRemoveDraft, onAddDraft, onApplyDraft, onApplyAllDrafts, onDiscardAllDrafts,
  onUpdateDraftPort, onPoliciesChanged, onSaveConfig,
}: Props) {
  const [activeTab, setActiveTab] = useState<Tab | null>(() => {
    try { return (localStorage.getItem('floodgate-active-tab') as Tab) || 'namespaces' } catch { return 'namespaces' }
  })
  const [approvalTabKey, setApprovalTabKey] = useState(0)
  const [showLabels, setShowLabels] = useState<boolean>(() => {
    try { return localStorage.getItem('floodgate-nav-labels') === 'true' } catch { return false }
  })
  const [showPwModal, setShowPwModal] = useState(false)

  // Allow parent (header avatar) to open the modal
  React.useEffect(() => { if (openPasswordModal) setShowPwModal(true) }, [openPasswordModal])

  const isViewer = currentUser?.role === 'viewer' || currentUser?.role === 'audit'
  const isAdmin  = currentUser?.role === 'admin'
  const allowedNamespaces = new Set(currentUser?.allowed_namespaces ?? [])
  const canManageNamespace = (namespace: string) => {
    if (!currentUser) return false
    if (currentUser.role === 'admin') return true
    if (currentUser.role === 'ns_admin') return allowedNamespaces.has(namespace)
    return false
  }

  const canSeeApprovals = config.approval_enabled && (() => {
    if (!currentUser) return false
    if (currentUser.role === 'admin' || currentUser.role === 'ns_admin') return true
    if (currentUser.role === 'viewer') {
      return pendingApprovals.some(r => r.allowed_approvers.some(a => a.id === currentUser.id))
    }
    return false
  })()

  const navItems: Array<{ id: Tab; icon: React.ReactNode; badge?: number }> = [
    { id: 'namespaces', icon: <Icon.Namespace /> },
    ...(!isViewer ? [{ id: 'drafts' as Tab, icon: <Icon.Draft />, badge: drafts.length }] : []),
    { id: 'policies',   icon: <Icon.Policy />,   badge: policies.length },
    ...(canSeeApprovals ? [{ id: 'aprovacoes' as Tab, icon: <Icon.Clock />, badge: pendingApprovals.length }] : []),
    { id: 'seguranca',  icon: <Icon.Shield /> },
    ...(isAdmin ? [{ id: 'config' as Tab, icon: <Icon.Config /> }] : []),
  ]

  // Validate restored tab against what this user can actually see
  useEffect(() => {
    if (!configLoaded) return
    if (currentUser && activeTab && !navItems.some(item => item.id === activeTab)) {
      setActiveTab('namespaces')
    }
  }, [configLoaded, currentUser, activeTab, navItems])

  useEffect(() => {
    if (!requestTab) return
    setActiveTab(requestTab)
    if (requestTab === 'aprovacoes') setApprovalTabKey(k => k + 1)
    onTabOpened?.()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestTab])

  function toggleTab(id: Tab) {
    setActiveTab(prev => {
      const next = prev === id ? null : id
      try { localStorage.setItem('floodgate-active-tab', next ?? '') } catch {}
      return next
    })
  }
  function toggleLabels() {
    setShowLabels(prev => {
      const next = !prev
      try { localStorage.setItem('floodgate-nav-labels', String(next)) } catch {}
      return next
    })
  }

  const railWidth = showLabels ? 158 : 48

  return (
    <div style={{ display: 'flex', height: '100%', flexShrink: 0 }}>

      {/* ── Nav Rail (left, always visible) ── */}
      <div style={{ width: railWidth, background: '#f8fafc', borderRight: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column', flexShrink: 0, transition: 'width 0.18s ease', paddingTop: 6 }}>

        {navItems.map(item => {
          const isActive = activeTab === item.id
          return (
            <button key={item.id} onClick={() => toggleTab(item.id)}
              title={!showLabels ? TAB_LABELS[item.id] : undefined}
              style={{
                width: '100%', minHeight: 52, border: 'none', cursor: 'pointer',
                background: isActive ? '#eff6ff' : 'transparent',
                borderRight: `3px solid ${isActive ? '#185FA5' : 'transparent'}`,
                color: isActive ? '#185FA5' : '#64748b',
                display: 'flex', alignItems: 'center',
                justifyContent: showLabels ? 'flex-start' : 'center',
                padding: showLabels ? '0 14px' : '0',
                gap: showLabels ? 10 : 0,
                position: 'relative', flexShrink: 0,
                transition: 'background 0.15s, color 0.15s, padding 0.18s',
              }}
            >
              <span style={{ flexShrink: 0 }}>{item.icon}</span>
              {showLabels && (
                <span style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, textAlign: 'left' }}>
                  {TAB_LABELS[item.id]}
                </span>
              )}
              {item.badge != null && item.badge > 0 && (
                <span style={{
                  position: showLabels ? 'static' : 'absolute',
                  top: showLabels ? undefined : 8, right: showLabels ? undefined : 8,
                  background: item.id === 'drafts' ? '#f59e0b' : '#10b981',
                  color: 'white', borderRadius: 9, fontSize: 9, fontWeight: 700,
                  minWidth: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  padding: '0 4px', flexShrink: 0,
                }}>
                  {item.badge}
                </span>
              )}
            </button>
          )
        })}

        {/* Page links at bottom */}
        <div style={{ marginTop: 'auto', borderTop: '1px solid #e2e8f0', position: 'relative' }}>

          {/* User chip — opens full-screen password modal */}
          <button
            onClick={() => setShowPwModal(true)}
            title={showLabels ? undefined : `${currentUser?.username} · Trocar senha`}
            style={{
              width: '100%', border: 'none', cursor: 'pointer', background: 'transparent',
              padding: showLabels ? '8px 10px' : '8px 6px',
              display: 'flex', alignItems: 'center', gap: 9,
              justifyContent: showLabels ? 'flex-start' : 'center',
              transition: 'background 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = '#eff6ff' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
          >
            {/* Avatar */}
            <div style={{
              width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
              background: 'linear-gradient(135deg, #185FA5 0%, #2563eb 100%)',
              color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 700, boxShadow: '0 1px 4px rgba(24,95,165,0.3)',
            }}>
              {(currentUser?.username?.[0] ?? '?').toUpperCase()}
            </div>
            {showLabels && (
              <div style={{ flex: 1, textAlign: 'left', overflow: 'hidden' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#0f172a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {currentUser?.username}
                </div>
                <div style={{ fontSize: 10, color: '#185FA5', fontWeight: 500 }}>Trocar senha</div>
              </div>
            )}
          </button>

          <PasswordModal
            open={showPwModal || !!currentUser?.must_change_password}
            username={currentUser?.username ?? ''}
            requireCurrentPassword
            forced={!!currentUser?.must_change_password}
            onClose={() => { setShowPwModal(false); onPasswordModalClosed?.() }}
            onSubmit={async (newPw, curPw) => { await updateUserPassword(currentUser!.id, newPw, curPw) }}
          />
          {(currentUser?.role === 'admin' || currentUser?.role === 'audit') && (
            <a href="/audit" title="Audit log"
              style={{
                width: '100%', minHeight: 44, border: 'none', cursor: 'pointer',
                background: 'transparent', color: '#64748b', textDecoration: 'none',
                display: 'flex', alignItems: 'center',
                justifyContent: showLabels ? 'flex-start' : 'center',
                padding: showLabels ? '0 14px' : '0', gap: 10,
                transition: 'color 0.15s, background 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.color = '#185FA5'; e.currentTarget.style.background = '#f0f6ff' }}
              onMouseLeave={e => { e.currentTarget.style.color = '#64748b'; e.currentTarget.style.background = 'transparent' }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
                <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
              </svg>
              {showLabels && <span style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>Audit log</span>}
            </a>
          )}
          {currentUser?.role === 'admin' && (
            <a href="/users" title="Usuários"
              style={{
                width: '100%', minHeight: 44, border: 'none', cursor: 'pointer',
                background: 'transparent', color: '#64748b', textDecoration: 'none',
                display: 'flex', alignItems: 'center',
                justifyContent: showLabels ? 'flex-start' : 'center',
                padding: showLabels ? '0 14px' : '0', gap: 10,
                transition: 'color 0.15s, background 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.color = '#185FA5'; e.currentTarget.style.background = '#f0f6ff' }}
              onMouseLeave={e => { e.currentTarget.style.color = '#64748b'; e.currentTarget.style.background = 'transparent' }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
                <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>
              </svg>
              {showLabels && <span style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>Usuários</span>}
            </a>
          )}
          <button onClick={toggleLabels} title={showLabels ? 'Ocultar nomes' : 'Mostrar nomes'}
            style={{
              width: '100%', height: 40, border: 'none', cursor: 'pointer',
              background: 'transparent', color: '#94a3b8', borderTop: '1px solid #f1f5f9',
              display: 'flex', alignItems: 'center',
              justifyContent: showLabels ? 'flex-start' : 'center',
              padding: showLabels ? '0 14px' : '0', gap: 10,
              transition: 'color 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.color = '#64748b' }}
            onMouseLeave={e => { e.currentTarget.style.color = '#94a3b8' }}
          >
            <Icon.Tag />
            {showLabels && <span style={{ fontSize: 11, fontWeight: 500, whiteSpace: 'nowrap' }}>Ocultar nomes</span>}
          </button>
        </div>
      </div>

      {/* ── Content Panel (opens to the right of nav rail) ── */}
      {activeTab && (
        <div style={{ width: 294, background: 'white', borderRight: '1px solid #e2e8f0', display: 'flex', flexDirection: 'column', height: '100%' }}>
          <div style={{ padding: '0 14px', height: 44, display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid #e2e8f0', flexShrink: 0, background: '#f8fafc' }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: '#185FA5', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{TAB_LABELS[activeTab]}</span>
            <button onClick={() => setActiveTab(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#cbd5e1', fontSize: 20, lineHeight: 1, padding: '0 2px', display: 'flex', alignItems: 'center', transition: 'color 0.15s' }} title="Fechar"
              onMouseEnter={e => { e.currentTarget.style.color = '#64748b' }}
              onMouseLeave={e => { e.currentTarget.style.color = '#cbd5e1' }}
            >×</button>
          </div>
          <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {activeTab === 'namespaces' && <NamespacesTab allNamespaces={allNamespaces} services={services} visibleNamespaces={visibleNamespaces} ignoredNamespaces={config.ignored_namespaces} onToggle={onToggleNamespace} />}
            {activeTab === 'drafts' && !isViewer && <DraftsTab drafts={drafts} services={services} config={config} currentUser={currentUser} onRemove={onRemoveDraft} onApply={onApplyDraft} onApplyAll={onApplyAllDrafts} onDiscardAll={onDiscardAllDrafts} onUpdatePort={onUpdateDraftPort} onAddDraft={onAddDraft} />}
            {activeTab === 'policies' && <PoliciesTab policies={policies} allPolicies={allPolicies} services={services} isAdmin={isAdmin} isViewer={isViewer} canManageNamespace={canManageNamespace} onDelete={onPoliciesChanged} onRefresh={onPoliciesChanged} />}
            {activeTab === 'aprovacoes' && <ApprovacoesTab key={approvalTabKey} currentUser={currentUser} config={config} onRefresh={onPoliciesChanged} pendingApprovals={pendingApprovals} />}
            {activeTab === 'seguranca' && <SegurancaTab services={services} policies={policies} config={config} isAdmin={isAdmin} canManageNamespace={canManageNamespace} onRefresh={onPoliciesChanged} />}
            {activeTab === 'config' && isAdmin && <ConfigTab config={config} onSave={onSaveConfig} />}
            {activeTab === 'config' && !isAdmin && <Forbidden />}
          </div>
        </div>
      )}
    </div>
  )
}
