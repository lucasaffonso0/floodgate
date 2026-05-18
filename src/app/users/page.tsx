'use client'

import { useState, useEffect } from 'react'
import { User, NamespacePermission } from '@/types'
import {
  getMe, listUsers, createUser, deleteUser, updateUserRole, updateUserPassword,
  getNamespacePermissions, grantNamespacePermission, revokeNamespacePermission,
  getServices,
} from '@/api/client'
import PasswordModal from '@/components/PasswordModal'

const ROLE_STYLE: Record<string, React.CSSProperties> = {
  admin:    { background: '#eff6ff', color: '#2563eb' },
  ns_admin: { background: '#f5f3ff', color: '#7c3aed' },
  viewer:   { background: '#f8fafc', color: '#64748b' },
  audit:    { background: '#fff7ed', color: '#c2410c' },
}

export default function UsersPage() {
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [users, setUsers] = useState<User[]>([])
  const [permissions, setPermissions] = useState<NamespacePermission[]>([])
  const [allNamespaces, setAllNamespaces] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newRole, setNewRole] = useState<'admin' | 'viewer' | 'audit'>('viewer')
  const [creating, setCreating] = useState(false)
  const [formError, setFormError] = useState('')
  const [expandedUser, setExpandedUser] = useState<string | null>(null)
  const [grantNs, setGrantNs] = useState('')
  const [granting, setGranting] = useState(false)
  const [passwordModal, setPasswordModal] = useState<{ userId: string; username: string } | null>(null)

  async function load() {
    setLoading(true)
    try {
      const [me, all, perms, svcs] = await Promise.all([getMe(), listUsers(), getNamespacePermissions(), getServices()])
      setCurrentUser(me)
      setUsers(all)
      setPermissions(perms)
      setAllNamespaces([...new Set(svcs.map(s => s.namespace))].sort())
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setFormError('')
    setCreating(true)
    try {
      await createUser({ username: newUsername, password: newPassword, role: newRole })
      setNewUsername(''); setNewPassword(''); setNewRole('viewer')
      await load()
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      setFormError(detail ?? 'Erro ao criar usuário')
    } finally {
      setCreating(false)
    }
  }

  async function handleDelete(id: string, username: string) {
    if (!confirm(`Remover usuário "${username}"?`)) return
    await deleteUser(id)
    await load()
  }

  async function handleChangeRole(user: User, newRole: 'admin' | 'viewer' | 'audit') {
    if (user.id === currentUser?.id) return
    await updateUserRole(user.id, newRole)
    await load()
  }

  async function handleGrant(userId: string) {
    if (!grantNs) return
    setGranting(true)
    try {
      await grantNamespacePermission(userId, grantNs)
      setGrantNs('')
      await load()
    } finally {
      setGranting(false)
    }
  }

  async function handleRevoke(permId: string) {
    await revokeNamespacePermission(permId)
    await load()
  }

  const userPerms = (userId: string) => permissions.filter(p => p.user_id === userId)

  const cell: React.CSSProperties = {
    padding: '12px 16px', fontSize: 13, color: '#374151',
    borderBottom: '1px solid #f1f5f9', verticalAlign: 'middle',
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc' }}>
      <header style={{ background: 'white', borderBottom: '1px solid #e2e8f0', padding: '0 24px', height: 56, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <a href="/" style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#64748b', fontSize: 13, textDecoration: 'none', fontWeight: 500 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5M12 5l-7 7 7 7"/></svg>
            Voltar ao painel
          </a>
          <span style={{ color: '#e2e8f0' }}>|</span>
          <span style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>Gerenciar Usuários</span>
        </div>
        {currentUser && (
          <div style={{ fontSize: 12, color: '#64748b' }}>Logado como <strong>{currentUser.username}</strong></div>
        )}
      </header>

      <div style={{ maxWidth: 900, margin: '0 auto', padding: '32px 24px' }}>
        {/* Users table */}
        <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e2e8f0', overflow: 'hidden', marginBottom: 32 }}>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid #f1f5f9' }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>Usuários</div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>{users.length} usuário(s) · clique em um para gerenciar namespaces</div>
          </div>

          {loading ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>Carregando…</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: '#f8fafc' }}>
                  {['Usuário', 'Role', 'Namespaces permitidos', 'Criado em', 'Ações'].map(h => (
                    <th key={h} style={{ ...cell, fontWeight: 700, fontSize: 10, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {users.map(u => {
                  const isMe = u.id === currentUser?.id
                  const perms = userPerms(u.id)
                  const isExpanded = expandedUser === u.id

                  return (
                    <>
                      <tr key={u.id} style={{ background: isMe ? '#fafbff' : 'white', cursor: 'pointer' }} onClick={() => setExpandedUser(isExpanded ? null : u.id)}>
                        <td style={cell}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{
                              width: 32, height: 32, borderRadius: '50%',
                              background: ROLE_STYLE[u.role]?.background ?? '#f8fafc',
                              border: `2px solid ${u.role === 'admin' ? '#bfdbfe' : u.role === 'ns_admin' ? '#ddd6fe' : '#e2e8f0'}`,
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              fontSize: 12, fontWeight: 700, color: ROLE_STYLE[u.role]?.color ?? '#94a3b8',
                            }}>
                              {u.username[0].toUpperCase()}
                            </div>
                            <div>
                              <div style={{ fontWeight: 600, color: '#0f172a' }}>{u.username}</div>
                              {isMe && <div style={{ fontSize: 10, color: '#94a3b8' }}>você</div>}
                            </div>
                          </div>
                        </td>
                        <td style={cell}>
                          {u.role === 'ns_admin' ? (
                            <div>
                              <span style={{ fontSize: 11, fontWeight: 700, borderRadius: 6, padding: '4px 10px', ...ROLE_STYLE.ns_admin, display: 'inline-block' }}>
                                NS Admin
                              </span>
                              <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>Remova os namespaces para trocar</div>
                            </div>
                          ) : (
                            <select
                              value={u.role}
                              disabled={isMe}
                              onClick={e => e.stopPropagation()}
                              onChange={e => { e.stopPropagation(); handleChangeRole(u, e.target.value as 'admin' | 'viewer' | 'audit') }}
                              title={isMe ? 'Não pode alterar o próprio role' : ''}
                              style={{
                                fontSize: 11, fontWeight: 700, borderRadius: 6, padding: '4px 10px', border: `1px solid ${u.role === 'admin' ? '#bfdbfe' : '#e2e8f0'}`,
                                cursor: isMe ? 'default' : 'pointer',
                                background: ROLE_STYLE[u.role]?.background ?? '#f8fafc',
                                color: ROLE_STYLE[u.role]?.color ?? '#64748b',
                                opacity: isMe ? 0.7 : 1,
                              }}
                            >
                              <option value="admin">Admin</option>
                              <option value="audit">Audit</option>
                              <option value="viewer">Viewer</option>
                            </select>
                          )}
                        </td>
                        <td style={{ ...cell, fontSize: 12 }}>
                          {perms.length === 0 ? (
                            <span style={{ color: '#cbd5e1' }}>{u.role === 'admin' ? 'todos (admin)' : '—'}</span>
                          ) : (
                            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                              {perms.slice(0, 3).map(p => (
                                <span key={p.id} style={{ background: '#f5f3ff', color: '#7c3aed', borderRadius: 4, padding: '1px 6px', fontSize: 10, fontWeight: 600 }}>{p.namespace}</span>
                              ))}
                              {perms.length > 3 && <span style={{ color: '#94a3b8', fontSize: 10 }}>+{perms.length - 3}</span>}
                            </div>
                          )}
                        </td>
                        <td style={{ ...cell, color: '#94a3b8', fontSize: 12 }}>
                          {new Date(u.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })}
                        </td>
                        <td style={{ ...cell, textAlign: 'right' }}>
                          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
                            <button
                              onClick={e => { e.stopPropagation(); setPasswordModal({ userId: u.id, username: u.username }) }}
                              style={{ background: '#eff6ff', color: '#185FA5', border: '1px solid #bfdbfe', borderRadius: 7, padding: '6px 12px', fontSize: 12, fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                              Senha
                            </button>
                            {!isMe && (
                              <button
                                onClick={e => { e.stopPropagation(); handleDelete(u.id, u.username) }}
                                style={{ background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 7, padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                              >
                                Remover
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>

                      {/* Expanded panel: namespace permissions only */}
                      {isExpanded && u.role !== 'admin' && (
                        <tr key={`${u.id}-ns`}>
                          <td colSpan={5} style={{ padding: 0, background: '#fafbff', borderBottom: '1px solid #e2e8f0' }}>
                            <div style={{ padding: '14px 24px' }}>
                              <div style={{ fontSize: 12, fontWeight: 700, color: '#475569', marginBottom: 10 }}>
                                Namespaces permitidos para <strong>{u.username}</strong>
                                <span style={{ marginLeft: 6, fontSize: 10, color: '#94a3b8', fontWeight: 400 }}>
                                  (NS Admin pode criar/deletar policies nestes namespaces)
                                </span>
                              </div>

                              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                                {perms.length === 0 ? (
                                  <span style={{ fontSize: 12, color: '#94a3b8', fontStyle: 'italic' }}>Nenhum namespace atribuído</span>
                                ) : (
                                  perms.map(p => (
                                    <span key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 4, background: '#f5f3ff', color: '#7c3aed', borderRadius: 6, padding: '4px 10px', fontSize: 12, fontWeight: 600 }}>
                                      {p.namespace}
                                      <button
                                        onClick={() => handleRevoke(p.id)}
                                        style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#7c3aed', padding: 0, fontSize: 14, lineHeight: 1, display: 'flex', alignItems: 'center' }}
                                        title="Remover acesso"
                                      >×</button>
                                    </span>
                                  ))
                                )}
                              </div>

                              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                <select
                                  value={grantNs}
                                  onChange={e => setGrantNs(e.target.value)}
                                  style={{ border: '1px solid #e2e8f0', borderRadius: 6, padding: '6px 10px', fontSize: 12, background: 'white', minWidth: 180 }}
                                >
                                  <option value="">Selecionar namespace…</option>
                                  {allNamespaces
                                    .filter(ns => !perms.some(p => p.namespace === ns))
                                    .map(ns => <option key={ns} value={ns}>{ns}</option>)
                                  }
                                </select>
                                <button
                                  onClick={() => handleGrant(u.id)}
                                  disabled={!grantNs || granting}
                                  style={{ background: '#7c3aed', color: 'white', border: 'none', borderRadius: 6, padding: '6px 14px', fontSize: 12, fontWeight: 600, cursor: grantNs ? 'pointer' : 'not-allowed', opacity: grantNs ? 1 : 0.5 }}
                                >
                                  {granting ? 'Concedendo…' : '+ Conceder acesso'}
                                </button>
                                <span style={{ fontSize: 11, color: '#94a3b8' }}>
                                  O usuário precisará fazer login novamente para o acesso entrar em vigor.
                                </span>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Create user form */}
        <div style={{ background: 'white', borderRadius: 12, border: '1px solid #e2e8f0', overflow: 'hidden' }}>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid #f1f5f9' }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#0f172a' }}>Novo usuário</div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>Crie um usuário com acesso admin, NS Admin ou somente visualização</div>
          </div>
          <form onSubmit={handleCreate} style={{ padding: 20 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 200px', gap: 12, marginBottom: 12 }}>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 5 }}>Username</label>
                <input value={newUsername} onChange={e => setNewUsername(e.target.value)} required placeholder="ex: joao.silva"
                  style={{ width: '100%', border: '1px solid #d1d5db', borderRadius: 8, padding: '9px 12px', fontSize: 13, boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 5 }}>Senha</label>
                <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} required placeholder="Senha inicial"
                  style={{ width: '100%', border: '1px solid #d1d5db', borderRadius: 8, padding: '9px 12px', fontSize: 13, boxSizing: 'border-box' }} />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 5 }}>Permissão</label>
                <select value={newRole} onChange={e => setNewRole(e.target.value as 'admin' | 'viewer' | 'audit')}
                  style={{ width: '100%', border: '1px solid #d1d5db', borderRadius: 8, padding: '9px 12px', fontSize: 13, background: 'white', boxSizing: 'border-box' }}>
                  <option value="viewer">Viewer</option>
                  <option value="audit">Audit</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
            </div>

            <div style={{ background: '#f8fafc', borderRadius: 8, padding: '10px 14px', marginBottom: 14, fontSize: 12, color: '#64748b' }}>
              <strong>Viewer</strong> — visualiza o painel, não pode criar nem remover nada.<br/>
              <strong>Audit</strong> — visualiza policies e logs de auditoria, somente leitura.<br/>
              <strong>NS Admin</strong> — gerencia policies em namespaces específicos (atribua namespaces após criar).<br/>
              <strong>Admin</strong> — acesso total: policies, usuários e configurações.
            </div>

            {formError && (
              <div style={{ background: '#fef2f2', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 12px', fontSize: 12, color: '#dc2626', marginBottom: 12 }}>
                {formError}
              </div>
            )}

            <button type="submit" disabled={creating}
              style={{ background: creating ? '#93c5fd' : '#2563eb', color: 'white', border: 'none', borderRadius: 8, padding: '10px 24px', fontSize: 13, fontWeight: 600, cursor: creating ? 'not-allowed' : 'pointer' }}>
              {creating ? 'Criando…' : '+ Criar usuário'}
            </button>
          </form>
        </div>
      </div>

      {/* Password modal — admin resets, no current_password required */}
      <PasswordModal
        open={passwordModal !== null}
        username={passwordModal?.username ?? ''}
        requireCurrentPassword={false}
        onClose={() => setPasswordModal(null)}
        onSubmit={async (newPassword) => {
          await updateUserPassword(passwordModal!.userId, newPassword)
        }}
      />
    </div>
  )
}
