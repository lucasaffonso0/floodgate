'use client'
import { useState, useEffect, useCallback, useRef } from 'react'

// ── Password strength ─────────────────────────────────────────────────────
function getStrength(p: string): { pct: number; label: string; color: string } {
  if (!p)          return { pct: 0,   label: '',            color: '#e2e8f0' }
  if (p.length < 10) return { pct: 15, label: 'Muito curta', color: '#ef4444' }
  const u = /[A-Z]/.test(p), l = /[a-z]/.test(p), n = /[0-9]/.test(p), s = /[^A-Za-z0-9]/.test(p)
  const v = [u, l, n, s].filter(Boolean).length
  if (v < 2) return { pct: 40, label: 'Fraca',  color: '#f97316' }
  if (v < 3) return { pct: 65, label: 'Média',  color: '#eab308' }
  if (v < 4) return { pct: 85, label: 'Boa',    color: '#22c55e' }
  return           { pct: 100, label: 'Forte',  color: '#16a34a' }
}

// ── Eye icon ──────────────────────────────────────────────────────────────
function EyeIcon({ visible }: { visible: boolean }) {
  return visible
    ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
    : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
}

// ── Field ─────────────────────────────────────────────────────────────────
function PwField({
  label, value, onChange, show, onToggle, placeholder, autoFocus,
}: {
  label: string; value: string; onChange: (v: string) => void
  show: boolean; onToggle: () => void; placeholder?: string; autoFocus?: boolean
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
        {label}
      </label>
      <div style={{ position: 'relative' }}>
        <input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          autoFocus={autoFocus}
          style={{
            width: '100%', boxSizing: 'border-box',
            border: '1.5px solid #e2e8f0', borderRadius: 8,
            padding: '10px 42px 10px 12px', fontSize: 14,
            outline: 'none', transition: 'border-color 0.15s',
            fontFamily: show ? 'inherit' : 'monospace',
          }}
          onFocus={e => { e.currentTarget.style.borderColor = '#185FA5' }}
          onBlur={e => { e.currentTarget.style.borderColor = '#e2e8f0' }}
        />
        <button
          type="button" onClick={onToggle} tabIndex={-1}
          style={{
            position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
            background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8',
            display: 'flex', alignItems: 'center', padding: 2,
          }}
        >
          <EyeIcon visible={show} />
        </button>
      </div>
    </div>
  )
}

// ── Modal ─────────────────────────────────────────────────────────────────
interface Props {
  open: boolean
  username: string
  requireCurrentPassword: boolean
  forced?: boolean
  onClose: () => void
  onSubmit: (newPassword: string, currentPassword?: string) => Promise<void>
}

export default function PasswordModal({ open, username, requireCurrentPassword, forced, onClose, onSubmit }: Props) {
  const [current, setCurrent]       = useState('')
  const [newPw,   setNewPw]         = useState('')
  const [confirm, setConfirm]       = useState('')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])
  const [showCur, setShowCur]       = useState(false)
  const [showNew, setShowNew]       = useState(false)
  const [showCon, setShowCon]       = useState(false)
  const [error,   setError]         = useState('')
  const [saving,  setSaving]        = useState(false)
  const [ok,      setOk]            = useState(false)

  // Reset on open
  useEffect(() => {
    if (open) { setCurrent(''); setNewPw(''); setConfirm(''); setError(''); setOk(false); setSaving(false) }
  }, [open])

  // ESC to close (disabled when forced)
  const handleKey = useCallback((e: KeyboardEvent) => { if (e.key === 'Escape' && !forced) onClose() }, [onClose, forced])
  useEffect(() => {
    if (!open) return
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [open, handleKey])

  const st = getStrength(newPw)
  const matchOk = confirm.length > 0 && newPw === confirm

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (requireCurrentPassword && !current) { setError('Informe sua senha atual.'); return }
    if (newPw.length < 10)                  { setError('Nova senha: mínimo 10 caracteres.'); return }
    if (newPw !== confirm)                  { setError('As senhas não coincidem.'); return }
    setSaving(true); setError('')
    try {
      await onSubmit(newPw, requireCurrentPassword ? current : undefined)
      setOk(true)
      if (forced) {
        timerRef.current = setTimeout(async () => {
          await fetch('/api/auth/logout', { method: 'POST' })
          window.location.href = '/login'
        }, 1800)
      } else {
        timerRef.current = setTimeout(onClose, 1600)
      }
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setError(detail ?? 'Erro ao alterar senha. Tente novamente.')
    } finally { setSaving(false) }
  }

  if (!open) return null

  return (
    <div
      onClick={forced ? undefined : onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: forced ? 'rgba(15, 23, 42, 0.75)' : 'rgba(15, 23, 42, 0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        backdropFilter: 'blur(2px)',
        animation: 'fadeIn 0.15s ease',
      }}
    >
      <style>{`@keyframes fadeIn{from{opacity:0}to{opacity:1}} @keyframes slideUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}`}</style>

      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'white', borderRadius: 16, width: '100%', maxWidth: 420,
          margin: '0 16px', boxShadow: '0 20px 60px rgba(0,0,0,0.18)',
          animation: 'slideUp 0.18s ease',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{ padding: '24px 24px 20px', borderBottom: '1px solid #f1f5f9' }}>
          {forced && (
            <div style={{ background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 8, padding: '8px 12px', marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#92400e', fontWeight: 600 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ flexShrink: 0 }}><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              Troca de senha obrigatória. Defina uma nova senha para continuar.
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: forced ? '#fef3c7' : '#eff6ff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={forced ? '#d97706' : '#185FA5'} strokeWidth="2">
                  <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                </svg>
              </div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>{forced ? 'Definir nova senha' : 'Alterar senha'}</div>
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 1 }}>{username}</div>
              </div>
            </div>
            {!forced && (
              <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', display: 'flex', borderRadius: 6, padding: 4 }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            )}
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} style={{ padding: 24 }}>
          {ok ? (
            <div style={{ textAlign: 'center', padding: '24px 0' }}>
              <div style={{ width: 56, height: 56, borderRadius: '50%', background: '#f0fdf4', border: '2px solid #bbf7d0', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 12px' }}>
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#16a34a" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              </div>
              <div style={{ fontSize: 15, fontWeight: 700, color: '#16a34a' }}>Senha alterada!</div>
              <div style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>
                {forced ? 'Redirecionando para login…' : 'Fechando automaticamente…'}
              </div>
            </div>
          ) : (
            <>
              {requireCurrentPassword && (
                <PwField
                  label="Senha atual" value={current} onChange={v => { setCurrent(v); setError('') }}
                  show={showCur} onToggle={() => setShowCur(v => !v)}
                  placeholder="Digite sua senha atual" autoFocus
                />
              )}

              <PwField
                label="Nova senha" value={newPw} onChange={v => { setNewPw(v); setError('') }}
                show={showNew} onToggle={() => setShowNew(v => !v)}
                placeholder="Mínimo 10 caracteres" autoFocus={!requireCurrentPassword}
              />

              {/* Strength bar */}
              {newPw.length > 0 && (
                <div style={{ marginTop: -10, marginBottom: 16 }}>
                  <div style={{ height: 4, background: '#f1f5f9', borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${st.pct}%`, background: st.color, borderRadius: 4, transition: 'width 0.3s, background 0.3s' }} />
                  </div>
                  <div style={{ fontSize: 11, color: st.color, fontWeight: 600, marginTop: 4 }}>{st.label}</div>
                </div>
              )}

              {/* Confirm */}
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 6 }}>
                  Confirmar nova senha
                  {confirm.length > 0 && (
                    <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 700, color: matchOk ? '#16a34a' : '#ef4444' }}>
                      {matchOk ? '✓ coincidem' : '✗ não coincidem'}
                    </span>
                  )}
                </label>
                <div style={{ position: 'relative' }}>
                  <input
                    type={showCon ? 'text' : 'password'}
                    value={confirm}
                    onChange={e => { setConfirm(e.target.value); setError('') }}
                    placeholder="Repita a nova senha"
                    style={{
                      width: '100%', boxSizing: 'border-box',
                      border: `1.5px solid ${confirm.length > 0 ? (matchOk ? '#22c55e' : '#f97316') : '#e2e8f0'}`,
                      borderRadius: 8, padding: '10px 42px 10px 12px', fontSize: 14,
                      outline: 'none', transition: 'border-color 0.15s',
                      fontFamily: showCon ? 'inherit' : 'monospace',
                    }}
                    onFocus={e => { if (!confirm) e.currentTarget.style.borderColor = '#185FA5' }}
                    onBlur={e => { if (!confirm) e.currentTarget.style.borderColor = '#e2e8f0' }}
                  />
                  <button type="button" onClick={() => setShowCon(v => !v)} tabIndex={-1}
                    style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', display: 'flex', padding: 2 }}>
                    <EyeIcon visible={showCon} />
                  </button>
                </div>
              </div>

              {/* Error */}
              {error && (
                <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '10px 12px', fontSize: 13, color: '#dc2626', marginBottom: 16, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, marginTop: 1 }}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                  {error}
                </div>
              )}

              {/* Actions */}
              <div style={{ display: 'flex', gap: 10 }}>
                {!forced && (
                  <button type="button" onClick={onClose}
                    style={{ flex: 1, background: '#f8fafc', color: '#64748b', border: '1.5px solid #e2e8f0', borderRadius: 8, padding: '10px 0', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>
                    Cancelar
                  </button>
                )}
                <button type="submit" disabled={saving || !newPw || !confirm}
                  style={{
                    flex: 2, background: saving ? '#93c5fd' : '#185FA5', color: 'white',
                    border: 'none', borderRadius: 8, padding: '10px 0', fontSize: 13,
                    fontWeight: 600, cursor: saving || !newPw || !confirm ? 'not-allowed' : 'pointer',
                    opacity: !newPw || !confirm ? 0.5 : 1,
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    transition: 'background 0.15s, opacity 0.15s',
                  }}>
                  {saving
                    ? <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" style={{ animation: 'spin 0.8s linear infinite' }}><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Salvando…</>
                    : <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> Alterar senha</>
                  }
                  <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
                </button>
              </div>
            </>
          )}
        </form>
      </div>
    </div>
  )
}
