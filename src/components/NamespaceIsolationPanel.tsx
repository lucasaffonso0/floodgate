'use client'

import React from 'react'
import { ServiceInfo, NetworkPolicyInfo, Draft } from '@/types'
import { deleteNetworkPolicy, isolateNamespace } from '@/api/client'
import { getNamespaceIsolation, getOtherPoliciesInNamespace } from '@/lib/nsIsolation'
import { computeEffectivePolicies } from '@/lib/simulate'

function NsDirRow({
  label, nsIsolated, nsPolicy, applying, isViewer, onApply, onRemove, draftBlocked,
}: {
  label: string
  nsIsolated: boolean
  nsPolicy: NetworkPolicyInfo | undefined
  applying: boolean
  isViewer?: boolean
  onApply: () => void
  onRemove: (p: NetworkPolicyInfo) => void
  draftBlocked?: boolean
}) {
  const dir = label === 'Inbound' ? 'ingress' : 'egress'
  const color = nsIsolated ? '#15803d' : '#dc2626'
  const bg    = nsIsolated ? '#f0fdf4' : '#fef2f2'
  return (
    <div>
      <div style={{ fontSize: 9, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>
        {label === 'Inbound' ? '↙' : '↗'} {label}
      </div>
      <div style={{ padding: '7px 10px', borderRadius: 7, background: bg, border: `1px solid ${color}33`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color }}>
          {nsIsolated ? `Default-deny ativo (namespace inteiro)` : 'Sem isolamento de namespace'}
        </span>
        {nsIsolated && nsPolicy
          ? !isViewer && (
            <button disabled={applying} onClick={() => onRemove(nsPolicy)} style={{
              padding: '3px 9px', fontSize: 9, fontWeight: 700,
              border: '1px solid #fca5a5', borderRadius: 5,
              background: '#fff1f2', color: '#dc2626',
              cursor: applying ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
            }}>
              Remover
            </button>
          )
          : !isViewer && !draftBlocked && (
            <button disabled={applying} onClick={onApply} style={{
              padding: '3px 9px', fontSize: 9, fontWeight: 700,
              border: '1px solid #93c5fd', borderRadius: 5,
              background: '#eff6ff', color: '#2563eb',
              cursor: applying ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
            }}>
              Isolar {dir}
            </button>
          )
        }
      </div>
      {!nsIsolated && draftBlocked && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 4 }}>
          <div style={{ fontSize: 9.5, fontWeight: 700, color: '#b45309', background: '#fef3c7', borderRadius: 5, padding: '3px 7px', display: 'inline-block', alignSelf: 'flex-start' }}>
            🧪 Seria isolado pelo rascunho
          </div>
          <div style={{ fontSize: 9, color: '#92400e' }}>Já há um rascunho pendente — veja a aba Rascunhos</div>
        </div>
      )}
    </div>
  )
}

// The interactive body of namespace isolation — status per direction, live
// intra/internet toggles, exceptions list, apply/remove. No outer chrome
// (no card, no header, no close button): the caller supplies that context.
// Shared between NetworkGraph's namespace panel and the Segurança tab so
// both always show and do exactly the same thing.
export function NamespaceIsolationPanel({
  namespace, services, policies, drafts, isViewer, canManageNamespace, onPolicyChanged, draftMode, onAddDraft,
}: {
  namespace: string; services: ServiceInfo[]; policies: NetworkPolicyInfo[]; drafts?: Draft[]
  canManageNamespace?: (namespace: string) => boolean
  isViewer?: boolean; onPolicyChanged: () => void
  draftMode?: boolean; onAddDraft?: (d: Omit<Draft, 'id'>) => void
}) {
  const [applying, setApplying]           = React.useState(false)
  const [allowIntra, setAllowIntra]       = React.useState(true)
  const [allowInternet, setAllowInternet] = React.useState(true)
  const [result, setResult]               = React.useState<string | null>(null)
  const canManageCurrent = typeof canManageNamespace === 'function' ? canManageNamespace(namespace) : !isViewer

  const iso = getNamespaceIsolation(namespace, policies)
  const { ingressPolicy: nsIngressPolicy, egressPolicy: nsEgressPolicy, isolatedIn: nsIsolatedIn, isolatedEg: nsIsolatedEg, anyIsolated, fullyIsolated } = iso

  // Modo Rascunho: essa direção está aberta nas policies reais, mas um
  // isolate (ou restrict de algum service dela) pendente vai fechá-la assim
  // que for aplicado — sem isso o painel de namespace parecia "normal" com
  // um rascunho pendente pra ela, igual ao que já foi corrigido no painel
  // de serviço.
  const effectivePolicies = draftMode && drafts ? computeEffectivePolicies(policies, drafts) : policies
  const effIso = draftMode ? getNamespaceIsolation(namespace, effectivePolicies) : iso
  const ingressDraftBlocked = !!draftMode && !nsIsolatedIn && effIso.isolatedIn
  const egressDraftBlocked  = !!draftMode && !nsIsolatedEg && effIso.isolatedEg

  // Live option detection: do these bonus policies already exist?
  const hasIntraPolicy    = policies.some(p => p.namespace === namespace && p.policy_type === 'allow-intranamespace')
  const hasInternetPolicy = policies.some(p => p.namespace === namespace && p.policy_type === 'allow-egress' && p.dst_service === 'internet')

  // Modo Rascunho: reflete no switch o estado que valeria DEPOIS de aplicar
  // o rascunho pendente (se houver um), não o real — e trava o switch nesse
  // meio tempo pra não empilhar um segundo rascunho contraditório em cima.
  const intraDraftPending    = !!draftMode && !!drafts?.some(d => d.kind === 'toggle' && d.toggle_namespace === namespace && d.toggle_option === 'intra')
  const internetDraftPending = !!draftMode && !!drafts?.some(d => d.kind === 'toggle' && d.toggle_namespace === namespace && d.toggle_option === 'internet')
  const effectiveHasIntraPolicy    = draftMode ? effectivePolicies.some(p => p.namespace === namespace && p.policy_type === 'allow-intranamespace') : hasIntraPolicy
  const effectiveHasInternetPolicy = draftMode ? effectivePolicies.some(p => p.namespace === namespace && p.policy_type === 'allow-egress' && p.dst_service === 'internet') : hasInternetPolicy

  async function apply(direction: 'ingress' | 'egress' | 'both') {
    if (draftMode) {
      onAddDraft?.({
        kind: 'isolate', isolate_namespace: namespace, isolate_direction: direction,
        isolate_allow_intra: allowIntra, isolate_allow_internet: allowInternet,
        src_workload: '', src_namespace: '', dst_service: '', dst_namespace: '', dst_ports: [], policy_direction: direction === 'both' ? 'both' : direction,
      })
      setResult('Adicionado aos rascunhos')
      return
    }
    setApplying(true); setResult(null)
    try {
      const r = await isolateNamespace({ namespace, direction, allow_intra_namespace: allowIntra, allow_egress_internet: allowInternet })
      setResult(`${r.created} criada(s), ${r.skipped} já existia(m)`)
      onPolicyChanged()
    } catch {
      setResult('Erro ao aplicar')
    } finally {
      setApplying(false)
    }
  }

  async function removePolicy(p: NetworkPolicyInfo) {
    // Se não sobrar nenhuma restrict namespace-wide, os companions da
    // isolação (intra, internet) ficam sem função e são limpos junto.
    const otherRestrict = policies.find(op =>
      op.namespace === namespace &&
      op.name !== p.name &&
      (op.policy_type === 'restrict-ingress' || op.policy_type === 'restrict-egress') &&
      op.dst_service === ''
    )
    const allCompanions = policies.filter(op =>
      op.namespace === namespace &&
      (op.policy_type === 'allow-intranamespace' ||
       (op.policy_type === 'allow-egress' && op.dst_service === 'internet'))
    )
    const companions = otherRestrict ? [] : allCompanions

    // Qualquer outra policy que sobrar continua restringindo implicitamente
    // o que ela seleciona, mesmo sem o restrict — avisa antes de deixar o
    // namespace "parecendo aberto" sem estar de verdade. O restrict da OUTRA
    // direção fica de fora: é isolamento próprio dela, não uma regra
    // residual, e remover só uma direção não pode apagar a outra também. Se
    // a outra direção sobrevive, os companions dela (intra/internet) também
    // ficam de fora — ainda servem pra isolação que continua ativa.
    const excludeNames = [p.name, ...companions.map(c => c.name)]
    if (otherRestrict) excludeNames.push(otherRestrict.name, ...allCompanions.map(c => c.name))
    const others = getOtherPoliciesInNamespace(namespace, excludeNames, policies)
    // Cancelar aqui precisa abortar a ação inteira — não só a parte de
    // remover as "outras" regras — senão o isolamento (e os companions dele)
    // são removidos de qualquer forma, mesmo com o usuário clicando Cancelar.
    if (others.length > 0) {
      const confirmed = confirm(
        `Remover o isolamento de "${namespace}" também remove ${others.length === 1 ? 'esta outra regra' : `estas outras ${others.length} regras`} (${others.map(o => o.name).join(', ')}), que ficariam sem função e continuariam restringindo o que elas selecionam.\n\nRemover tudo?`
      )
      if (!confirmed) return
    }

    setApplying(true); setResult(null)
    try {
      await deleteNetworkPolicy(p.namespace, p.name)
      await Promise.all(companions.map(op => deleteNetworkPolicy(op.namespace, op.name).catch(() => {})))
      if (others.length > 0) {
        await Promise.all(others.map(op => deleteNetworkPolicy(op.namespace, op.name).catch(() => {})))
      }
      onPolicyChanged()
    } catch {
      setResult('Erro ao remover')
    } finally {
      setApplying(false)
    }
  }

  async function toggleIntra() {
    if (draftMode) {
      if (intraDraftPending) return
      const directions: ('ingress' | 'egress')[] = nsIsolatedIn && nsIsolatedEg ? ['ingress', 'egress'] : nsIsolatedIn ? ['ingress'] : ['egress']
      onAddDraft?.({
        kind: 'toggle', toggle_namespace: namespace, toggle_option: 'intra',
        toggle_action: hasIntraPolicy ? 'disable' : 'enable', toggle_directions: directions,
        src_workload: '', src_namespace: '', dst_service: '', dst_namespace: '', dst_ports: [], policy_direction: 'both',
      })
      setResult('Adicionado aos rascunhos')
      return
    }
    setApplying(true); setResult(null)
    try {
      if (hasIntraPolicy) {
        const toRemove = policies.filter(p => p.namespace === namespace && p.policy_type === 'allow-intranamespace')
        await Promise.all(toRemove.map(p => deleteNetworkPolicy(p.namespace, p.name)))
      } else {
        const dir = nsIsolatedIn && nsIsolatedEg ? 'both' : nsIsolatedIn ? 'ingress' : 'egress'
        await isolateNamespace({ namespace, direction: dir, allow_intra_namespace: true, allow_egress_internet: false })
      }
      onPolicyChanged()
    } catch { setResult('Erro') } finally { setApplying(false) }
  }

  async function toggleInternet() {
    if (draftMode) {
      if (internetDraftPending) return
      onAddDraft?.({
        kind: 'toggle', toggle_namespace: namespace, toggle_option: 'internet',
        toggle_action: hasInternetPolicy ? 'disable' : 'enable',
        src_workload: '', src_namespace: '', dst_service: '', dst_namespace: '', dst_ports: [], policy_direction: 'egress',
      })
      setResult('Adicionado aos rascunhos')
      return
    }
    setApplying(true); setResult(null)
    try {
      if (hasInternetPolicy) {
        const toRemove = policies.filter(p => p.namespace === namespace && p.policy_type === 'allow-egress' && p.dst_service === 'internet')
        await Promise.all(toRemove.map(p => deleteNetworkPolicy(p.namespace, p.name)))
      } else {
        await isolateNamespace({ namespace, direction: 'egress', allow_intra_namespace: false, allow_egress_internet: true })
      }
      onPolicyChanged()
    } catch { setResult('Erro') } finally { setApplying(false) }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <NsDirRow label="Inbound"  nsIsolated={nsIsolatedIn} nsPolicy={nsIngressPolicy} applying={applying} isViewer={!canManageCurrent} onApply={() => apply('ingress')} onRemove={removePolicy} draftBlocked={ingressDraftBlocked} />
      <div style={{ borderTop: '1px solid #f1f5f9' }} />
      <NsDirRow label="Outbound" nsIsolated={nsIsolatedEg} nsPolicy={nsEgressPolicy}  applying={applying} isViewer={!canManageCurrent} onApply={() => apply('egress')}  onRemove={removePolicy} draftBlocked={egressDraftBlocked} />

      {/* ── Exceptions section ── */}
      {(nsIsolatedIn || nsIsolatedEg) && (() => {
        const ingressEx = policies.filter(p =>
          p.namespace === namespace &&
          (p.policy_type === 'allow' || p.policy_type === 'allow-namespace') &&
          p.dst_service !== ''
        )
        const egressEx = policies.filter(p =>
          p.namespace === namespace &&
          p.policy_type === 'allow-egress' &&
          p.src_workload !== ''
        )
        if (ingressEx.length === 0 && egressEx.length === 0) return (
          <div key="no-exceptions">
            <div style={{ borderTop: '1px solid #f1f5f9' }} />
            <div style={{ fontSize: 9, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3 }}>
              Exceções
            </div>
            <div style={{ fontSize: 10, color: '#94a3b8', fontStyle: 'italic' }}>Nenhuma: namespace totalmente fechada.</div>
          </div>
        )
        return (
          <div key="exceptions">
            <div style={{ borderTop: '1px solid #f1f5f9' }} />
            <div style={{ fontSize: 9, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
              Exceções: {ingressEx.length + egressEx.length} política(s) de allow
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {ingressEx.map(p => (
                <div key={p.name} style={{ padding: '5px 8px', borderRadius: 6, background: '#f0fdf4', border: '1px solid #bbf7d0' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
                    <span style={{ fontSize: 9, fontWeight: 700, color: '#15803d', background: '#dcfce7', border: '1px solid #86efac', borderRadius: 99, padding: '1px 5px', whiteSpace: 'nowrap', flexShrink: 0 }}>↙ IN</span>
                    <span style={{ fontSize: 10, fontWeight: 700, color: '#15803d', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{p.dst_service}</span>
                    <span style={{ fontSize: 9, fontWeight: 600, color: '#6b7280', flexShrink: 0 }}>:{p.dst_port}</span>
                  </div>
                  <div style={{ fontSize: 9, color: '#6b7280', paddingLeft: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    ← {p.src_namespace !== namespace ? `${p.src_namespace}/` : ''}{p.src_workload || 'namespace inteiro'}
                  </div>
                </div>
              ))}
              {egressEx.map(p => (
                <div key={p.name} style={{ padding: '5px 8px', borderRadius: 6, background: '#faf5ff', border: '1px solid #e9d5ff' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
                    <span style={{ fontSize: 9, fontWeight: 700, color: '#7e22ce', background: '#f3e8ff', border: '1px solid #d8b4fe', borderRadius: 99, padding: '1px 5px', whiteSpace: 'nowrap', flexShrink: 0 }}>↗ EG</span>
                    <span style={{ fontSize: 10, fontWeight: 700, color: '#7e22ce', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{p.src_workload}</span>
                    <span style={{ fontSize: 9, fontWeight: 600, color: '#6b7280', flexShrink: 0 }}>:{p.dst_port}</span>
                  </div>
                  <div style={{ fontSize: 9, color: '#6b7280', paddingLeft: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    → {p.dst_service}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )
      })()}

      {canManageCurrent && (
        <>
          <div style={{ borderTop: '1px solid #f1f5f9' }} />

          {/* Live toggles: shown whenever at least one direction is isolated */}
          {anyIsolated && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 9, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Opções de isolamento</div>
              {/* Intra-namespace toggle */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 10px', borderRadius: 7, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 600, color: '#334155' }}>Tráfego interno</div>
                  <div style={{ fontSize: 9, color: '#94a3b8' }}>Allow entre pods do mesmo namespace</div>
                </div>
                <button
                  disabled={applying || intraDraftPending}
                  onClick={toggleIntra}
                  title={intraDraftPending ? 'Já há um rascunho pendente pra esse toggle — veja a aba Rascunhos' : undefined}
                  style={{
                    width: 36, height: 20, borderRadius: 10, border: 'none', cursor: (applying || intraDraftPending) ? 'not-allowed' : 'pointer',
                    background: effectiveHasIntraPolicy ? '#10b981' : '#cbd5e1', position: 'relative', flexShrink: 0, transition: 'background 0.2s', padding: 0,
                    opacity: intraDraftPending ? 0.6 : 1,
                    boxShadow: draftMode && effectiveHasIntraPolicy !== hasIntraPolicy ? '0 0 0 2px #fde68a' : 'none',
                  }}
                >
                  <span style={{ position: 'absolute', top: 2, left: effectiveHasIntraPolicy ? 18 : 2, width: 16, height: 16, borderRadius: '50%', background: 'white', transition: 'left 0.2s', display: 'block' }} />
                </button>
              </div>
              {intraDraftPending && (
                <div style={{ fontSize: 9, color: '#92400e', marginTop: -3 }}>🧪 Rascunho pendente — veja a aba Rascunhos</div>
              )}
              {/* Internet egress toggle: only relevant when egress is isolated */}
              {nsIsolatedEg && (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 10px', borderRadius: 7, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
                  <div>
                    <div style={{ fontSize: 10, fontWeight: 600, color: '#334155' }}>Saída para internet</div>
                    <div style={{ fontSize: 9, color: '#94a3b8' }}>Libera egress ports 80/443 (IPs públicos)</div>
                  </div>
                  <button
                    disabled={applying || internetDraftPending}
                    onClick={toggleInternet}
                    title={internetDraftPending ? 'Já há um rascunho pendente pra esse toggle — veja a aba Rascunhos' : undefined}
                    style={{
                      width: 36, height: 20, borderRadius: 10, border: 'none', cursor: (applying || internetDraftPending) ? 'not-allowed' : 'pointer',
                      background: effectiveHasInternetPolicy ? '#10b981' : '#cbd5e1', position: 'relative', flexShrink: 0, transition: 'background 0.2s', padding: 0,
                      opacity: internetDraftPending ? 0.6 : 1,
                      boxShadow: draftMode && effectiveHasInternetPolicy !== hasInternetPolicy ? '0 0 0 2px #fde68a' : 'none',
                    }}
                  >
                    <span style={{ position: 'absolute', top: 2, left: effectiveHasInternetPolicy ? 18 : 2, width: 16, height: 16, borderRadius: '50%', background: 'white', transition: 'left 0.2s', display: 'block' }} />
                  </button>
                </div>
              )}
              {internetDraftPending && (
                <div style={{ fontSize: 9, color: '#92400e', marginTop: -3 }}>🧪 Rascunho pendente — veja a aba Rascunhos</div>
              )}
            </div>
          )}

          {/* Pre-apply options: shown only when not fully isolated yet. Once
              both directions already have a pending draft, neither this
              button nor the individual "Isolar ingress/egress" ones below
              are actionable anymore — hide the toggles too, since nothing
              left in this panel would consume them. */}
          {!fullyIsolated && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {ingressDraftBlocked && egressDraftBlocked ? (
                <div style={{ fontSize: 9, color: '#92400e', textAlign: 'center' }}>
                  🧪 Já há um rascunho pendente pras duas direções — veja a aba Rascunhos
                </div>
              ) : (
                <>
                  {!anyIsolated && (
                    <>
                      <div style={{ fontSize: 9, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Opções de isolamento</div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 10px', borderRadius: 7, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
                        <div>
                          <div style={{ fontSize: 10, fontWeight: 600, color: '#334155' }}>Tráfego interno</div>
                          <div style={{ fontSize: 9, color: '#94a3b8' }}>Allow entre pods do mesmo namespace</div>
                        </div>
                        <button onClick={() => setAllowIntra(v => !v)} style={{ width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer', background: allowIntra ? '#10b981' : '#cbd5e1', position: 'relative', flexShrink: 0, transition: 'background 0.2s', padding: 0 }}>
                          <span style={{ position: 'absolute', top: 2, left: allowIntra ? 18 : 2, width: 16, height: 16, borderRadius: '50%', background: 'white', transition: 'left 0.2s', display: 'block' }} />
                        </button>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 10px', borderRadius: 7, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
                        <div>
                          <div style={{ fontSize: 10, fontWeight: 600, color: '#334155' }}>Saída para internet</div>
                          <div style={{ fontSize: 9, color: '#94a3b8' }}>Libera egress ports 80/443 (IPs públicos)</div>
                        </div>
                        <button onClick={() => setAllowInternet(v => !v)} style={{ width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer', background: allowInternet ? '#10b981' : '#cbd5e1', position: 'relative', flexShrink: 0, transition: 'background 0.2s', padding: 0 }}>
                          <span style={{ position: 'absolute', top: 2, left: allowInternet ? 18 : 2, width: 16, height: 16, borderRadius: '50%', background: 'white', transition: 'left 0.2s', display: 'block' }} />
                        </button>
                      </div>
                    </>
                  )}
                  <button
                    disabled={applying}
                    onClick={() => apply('both')}
                    style={{
                      width: '100%', padding: '8px 12px', fontSize: 11, fontWeight: 600,
                      background: applying ? '#dbeafe' : '#eff6ff', color: applying ? '#93c5fd' : '#2563eb',
                      border: `1.5px solid ${applying ? '#bfdbfe' : '#93c5fd'}`, borderRadius: 7, cursor: applying ? 'not-allowed' : 'pointer',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                      opacity: applying ? 0.7 : 1,
                    }}
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <rect x="3" y="11" width="18" height="11" rx="2"/>
                      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                    </svg>
                    {applying ? 'Aplicando…' : 'Isolar namespace inteiro'}
                  </button>
                </>
              )}
            </div>
          )}

          {/* Remove isolation */}
          {anyIsolated && (
            <button
              disabled={applying}
              onClick={async () => {
                setApplying(true); setResult(null)
                try {
                  if (nsIngressPolicy) await deleteNetworkPolicy(nsIngressPolicy.namespace, nsIngressPolicy.name)
                  if (nsEgressPolicy)  await deleteNetworkPolicy(nsEgressPolicy.namespace, nsEgressPolicy.name)
                  // Remove companion policies created by isolateNamespace (intra-namespace allow + internet egress)
                  const companions = policies.filter(p =>
                    p.namespace === namespace &&
                    (p.policy_type === 'allow-intranamespace' ||
                     (p.policy_type === 'allow-egress' && p.dst_service === 'internet'))
                  )
                  for (const c of companions) await deleteNetworkPolicy(c.namespace, c.name)
                  onPolicyChanged()
                } catch {
                  setResult('Erro ao remover')
                } finally {
                  setApplying(false)
                }
              }}
              style={{
                width: '100%', padding: '8px 12px', fontSize: 11, fontWeight: 600,
                background: applying ? '#fce7e7' : '#fff1f2', color: applying ? '#fca5a5' : '#dc2626',
                border: `1.5px solid ${applying ? '#fca5a5' : '#f87171'}`, borderRadius: 7,
                cursor: applying ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                opacity: applying ? 0.6 : 1,
              }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <rect x="3" y="11" width="18" height="11" rx="2"/>
                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                <line x1="3" y1="3" x2="21" y2="21"/>
              </svg>
              {applying ? 'Removendo…' : fullyIsolated ? 'Remover isolamento' : nsIsolatedIn ? 'Remover isolamento (ingress)' : 'Remover isolamento (egress)'}
            </button>
          )}
        </>
      )}

      {result && (
        <div style={{ fontSize: 10, color: result.startsWith('Erro') ? '#dc2626' : '#15803d', textAlign: 'center', fontWeight: 600 }}>
          {result}
        </div>
      )}
    </div>
  )
}
