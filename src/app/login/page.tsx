'use client'

import React, { useState } from 'react'
import { FloodgateLogoFull } from '@/components/FloodgateLogo'

export default function LoginPage() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError]       = useState('')
  const [loading, setLoading]   = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (res.ok) {
        window.location.href = '/'
      } else {
        const data = await res.json()
        setError(data.detail ?? 'Credenciais inválidas')
      }
    } catch {
      setError('Erro de conexão')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'linear-gradient(135deg, #e8f0fb 0%, #eef2f7 60%, #e2eaf5 100%)',
    }}>
      <div style={{
        background: 'white',
        borderRadius: 20,
        width: 400,
        boxShadow: '0 8px 48px rgba(24,95,165,0.13), 0 2px 8px rgba(0,0,0,0.06)',
        border: '1px solid rgba(24,95,165,0.10)',
        overflow: 'hidden',
      }}>

        {/* Logo section */}
        <div style={{
          padding: '36px 40px 28px',
          borderBottom: '1px solid #f1f5f9',
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          background: 'linear-gradient(180deg, #fafcff 0%, #ffffff 100%)',
        }}>
          <FloodgateLogoFull width={300} />
        </div>

        {/* Form section */}
        <div style={{ padding: '28px 40px 36px' }}>
          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: 18 }}>
              <label style={{
                display: 'block', fontSize: 12, fontWeight: 600,
                color: '#374151', marginBottom: 6, letterSpacing: '0.02em',
              }}>
                Usuário
              </label>
              <input
                type="text"
                value={username}
                onChange={e => setUsername(e.target.value)}
                autoComplete="username"
                required
                placeholder="seu usuário"
                style={{
                  width: '100%', border: '1.5px solid #e2e8f0', borderRadius: 10,
                  padding: '11px 14px', fontSize: 14, boxSizing: 'border-box',
                  outline: 'none', background: '#f8fafc', color: '#0f172a',
                  transition: 'border-color 0.15s, background 0.15s',
                }}
                onFocus={e => { e.target.style.borderColor = '#185FA5'; e.target.style.background = '#fff' }}
                onBlur={e =>  { e.target.style.borderColor = '#e2e8f0'; e.target.style.background = '#f8fafc' }}
              />
            </div>

            <div style={{ marginBottom: 24 }}>
              <label style={{
                display: 'block', fontSize: 12, fontWeight: 600,
                color: '#374151', marginBottom: 6, letterSpacing: '0.02em',
              }}>
                Senha
              </label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                placeholder="••••••••"
                style={{
                  width: '100%', border: '1.5px solid #e2e8f0', borderRadius: 10,
                  padding: '11px 14px', fontSize: 14, boxSizing: 'border-box',
                  outline: 'none', background: '#f8fafc', color: '#0f172a',
                  transition: 'border-color 0.15s, background 0.15s',
                }}
                onFocus={e => { e.target.style.borderColor = '#185FA5'; e.target.style.background = '#fff' }}
                onBlur={e =>  { e.target.style.borderColor = '#e2e8f0'; e.target.style.background = '#f8fafc' }}
              />
            </div>

            {error && (
              <div style={{
                background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 10,
                padding: '10px 14px', fontSize: 12, color: '#dc2626',
                marginBottom: 18, display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2.5" style={{ flexShrink: 0 }}>
                  <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              style={{
                width: '100%',
                background: loading ? '#93c5fd' : '#185FA5',
                color: 'white', border: 'none', borderRadius: 10,
                padding: '13px', fontSize: 14, fontWeight: 600,
                cursor: loading ? 'not-allowed' : 'pointer',
                transition: 'background 0.15s, transform 0.1s',
                letterSpacing: '0.02em',
              }}
              onMouseEnter={e => { if (!loading) e.currentTarget.style.background = '#0C447C' }}
              onMouseLeave={e => { if (!loading) e.currentTarget.style.background = '#185FA5' }}
            >
              {loading ? 'Entrando…' : 'Entrar'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
