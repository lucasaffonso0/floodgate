'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { FloodgateLogoIcon } from '@/components/FloodgateLogo'
import { ServiceInfo, NetworkPolicyInfo, Draft, AppConfig, User, ServiceLayout, AutosyncStatus, ApprovalRequest, CiliumFlowSummary } from '@/types'
import {
  getServices, getNetworkPolicies, getAllNetworkPolicies,
  getConfig, updateConfig, createNetworkPolicy, createEgressNetworkPolicy, createCidrPolicy,
  createApprovalRequest, getSecurityCoverage, getAutosyncStatus,
  getMe, logout, getServiceLayout, setNamespaceLayoutLock,
  saveAllLayout, setGlobalLayoutLock, getApprovalRequests,
  getCiliumFlows, clearCiliumFlows,
} from '@/api/client'
import NetworkGraph from '@/components/NetworkGraph'
import RightPanel from '@/components/RightPanel'

const POLL_INTERVAL = 15_000
const LS_KEY = 'floodgate-hidden-namespaces'
const LS_AUTOSAVE_KEY = 'floodgate-layout-autosave'
const LS_DRAFT_KEY = 'floodgate-layout-draft'

type LayoutDraft = {
  services: Record<string, { x: number; y: number }>  // key: "namespace/service_name"
  namespaces: Record<string, { x: number; y: number }>
}

function loadLayoutDraft(): LayoutDraft | null {
  try {
    const r = sessionStorage.getItem(LS_DRAFT_KEY) ?? localStorage.getItem(LS_DRAFT_KEY)
    return r ? JSON.parse(r) : null
  } catch { return null }
}
function saveLayoutDraft(draft: LayoutDraft) {
  try {
    sessionStorage.setItem(LS_DRAFT_KEY, JSON.stringify(draft))
    localStorage.removeItem(LS_DRAFT_KEY)  // migrate away from localStorage
  } catch {}
}
function clearLayoutDraft() {
  try { sessionStorage.removeItem(LS_DRAFT_KEY) } catch {}
  try { localStorage.removeItem(LS_DRAFT_KEY) } catch {}
}

function loadHiddenFromStorage(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_KEY)
    return raw ? new Set(JSON.parse(raw)) : new Set()
  } catch { return new Set() }
}

function saveHiddenToStorage(hidden: Set<string>) {
  localStorage.setItem(LS_KEY, JSON.stringify([...hidden]))
}

const DEFAULT_CONFIG: AppConfig = {
  watched_namespaces: [],
  ignored_namespaces: ['kube-system', 'kube-public', 'kube-node-lease'],
  approval_enabled: false,
  approval_required_count: 1,
  approval_default_approvers: [],
  auto_default_deny_enabled: false,
  auto_default_deny_direction: 'ingress',
  autosync_enabled: false,
  autosync_interval_s: 60,
  hubble_discovery_enabled: false,
  hubble_flow_retention_days: 7,
}

function SaveSpinner({ status }: { status: 'idle' | 'saving' | 'draft' | 'saved' | 'error' }) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (status !== 'saving') return
    const id = setInterval(() => setTick(t => t + 1), 160)
    return () => clearInterval(id)
  }, [status])
  if (status === 'idle') return null
  const frames = ['⠋', '⠙', '⠸', '⠴', '⠦', '⠇']
  const cfg = {
    saving: { color: '#2563eb', bg: '#eff6ff', border: '#bfdbfe', label: `${frames[tick % frames.length]} Salvando…` },
    draft:  { color: '#6d28d9', bg: '#f5f3ff', border: '#ddd6fe', label: '✏ Rascunho local' },
    saved:  { color: '#059669', bg: '#f0fdf4', border: '#bbf7d0', label: '✓ Salvo' },
    error:  { color: '#dc2626', bg: '#fef2f2', border: '#fecaca', label: '✗ Erro ao salvar' },
  }[status]
  return (
    <span style={{
      display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 700,
      color: cfg.color, padding: '2px 8px', borderRadius: 20,
      background: cfg.bg, border: `1px solid ${cfg.border}`,
    }}>
      {cfg.label}
    </span>
  )
}

export default function App() {
  const configRef = useRef<AppConfig>(DEFAULT_CONFIG)
  const pendingLayouts = useRef<Map<string, { x: number; y: number }>>(new Map())
  const layoutInitialized = useRef(false)
  const [currentUser, setCurrentUser] = useState<User | null>(null)
  const [services, setServices] = useState<ServiceInfo[]>([])
  const [policies, setPolicies] = useState<NetworkPolicyInfo[]>([])
  const [allPolicies, setAllPolicies] = useState<NetworkPolicyInfo[]>([])
  const [allNamespaces, setAllNamespaces] = useState<string[]>([])
  const [visibleNamespaces, setVisibleNamespaces] = useState<Set<string>>(new Set())
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [serviceLayouts, setServiceLayouts] = useState<ServiceLayout[]>([])
  const savedServiceLayoutsRef = useRef<ServiceLayout[]>([])
  const [localNsPositions, setLocalNsPositions] = useState<Record<string, { x: number; y: number }>>({})
  const [savedNsPositions, setSavedNsPositions] = useState<Record<string, { x: number; y: number }>>({})
  const savedNsPositionsRef = useRef<Record<string, { x: number; y: number }>>({}) // discard baseline, never triggers re-render
  const [namespaceLocks, setNamespaceLocks] = useState<Record<string, boolean>>({})
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG)
  const [configLoaded, setConfigLoaded] = useState(false)
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([])
  const [autosyncStatus, setAutosyncStatus] = useState<AutosyncStatus | null>(null)
  const [globalLayoutLocked, setGlobalLayoutLocked] = useState(false)
  const [layoutMeta, setLayoutMeta] = useState<{ saved_by: string; saved_at: string } | null>(null)
  const [layoutResetKey, setLayoutResetKey] = useState(0)
  const [layoutSaveStatus, setLayoutSaveStatus] = useState<'idle' | 'saving' | 'draft' | 'saved' | 'error'>('idle')
  const [autosave, setAutosave] = useState<boolean>(() => {
    try { return localStorage.getItem(LS_AUTOSAVE_KEY) !== 'false' } catch { return true }
  })
  const autosaveRef = useRef(autosave)
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draftTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingServiceChanges = useRef<Map<string, { namespace: string; service_name: string; x: number; y: number }>>(new Map())
  const pendingNsChanges = useRef<Record<string, { x: number; y: number }>>({})
  const [error, setError] = useState<string | null>(null)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [showApprovalToast, setShowApprovalToast] = useState(false)
  const [openPasswordModal, setOpenPasswordModal] = useState(false)
  const [requestTab, setRequestTab] = useState<'aprovacoes' | 'drafts' | null>(null)
  const [ciliumFlows, setCiliumFlows] = useState<CiliumFlowSummary[]>([])
  const [ciliumStreaming, setCiliumStreaming] = useState(false)
  const currentUserRef = useRef<User | null>(null)

  const refresh = useCallback(async () => {
    try {
      const [svcs, pols, allPols, layoutData, sync, approvals, ciliumData] = await Promise.all([
        getServices(), getNetworkPolicies(), getAllNetworkPolicies(), getServiceLayout(),
        getAutosyncStatus().catch(() => null),
        getApprovalRequests('pending').catch(() => [] as ApprovalRequest[]),
        getCiliumFlows().catch(() => ({ available: false, streaming: false, flows: [] as CiliumFlowSummary[] })),
      ])
      setAutosyncStatus(sync)
      setServices(svcs)
      setPolicies(pols)
      setAllPolicies(allPols)
      setPendingApprovals(approvals)
      setCiliumFlows(ciliumData.flows)
      setCiliumStreaming(ciliumData.streaming)

      // Protect in-flight dragged positions from being overwritten by poll
      const dbLayouts = layoutData.layouts.map(l => {
        const pending = pendingLayouts.current.get(`${l.namespace}/${l.service_name}`)
        return pending ? { ...l, x: pending.x, y: pending.y } : l
      })
      savedServiceLayoutsRef.current = dbLayouts
      if (!layoutInitialized.current) {
        // First load: always start from DB — draft is restored later in didInitUserLayout
        setServiceLayouts(dbLayouts)
      } else if (pendingLayouts.current.size === 0 && !loadLayoutDraft()) {
        // Subsequent polls with no local changes → always reflect DB (picks up admin layout changes)
        setServiceLayouts(dbLayouts)
      }

      const nsFromDB: Record<string, { x: number; y: number }> = {}
      for (const row of layoutData.namespace_locks) {
        if (row.x !== null && row.y !== null) nsFromDB[row.namespace] = { x: row.x, y: row.y }
      }
      const nsForGraph = { ...nsFromDB, ...pendingNsChanges.current }
      savedNsPositionsRef.current = { ...nsFromDB }
      setSavedNsPositions(nsForGraph)
      if (!layoutInitialized.current) {
        setLocalNsPositions(nsFromDB)
        layoutInitialized.current = true
      } else if (Object.keys(pendingNsChanges.current).length === 0 && !loadLayoutDraft()) {
        setLocalNsPositions(nsFromDB)
      }

      // Namespace drag locks — default unlocked so services are draggable
      const locks: Record<string, boolean> = {}
      for (const ns of layoutData.namespaces) locks[ns] = false
      for (const row of layoutData.namespace_locks) locks[row.namespace] = row.locked
      setNamespaceLocks(locks)

      setGlobalLayoutLocked(layoutData.global_locked)
      setLayoutMeta(layoutData.layout_meta)

      const nsArr = [...new Set(svcs.map(s => s.namespace))].sort()
      setAllNamespaces(nsArr)
      setVisibleNamespaces(() => {
        const hidden = loadHiddenFromStorage()
        return new Set(nsArr.filter(ns => !hidden.has(ns)))
      })

      if (configRef.current.auto_default_deny_enabled) {
        getSecurityCoverage().catch(() => {})
      }
      setLastUpdate(new Date())
      setError(null)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Erro ao conectar ao backend')
    }
  }, [])

  const flushAutosave = useCallback(async () => {
    const svcChanges = [...pendingServiceChanges.current.values()]
    const nsEntries = Object.entries(pendingNsChanges.current)
    pendingNsChanges.current = {}
    pendingServiceChanges.current.clear()
    if (svcChanges.length === 0 && nsEntries.length === 0) { setLayoutSaveStatus('idle'); return }
    try {
      await saveAllLayout({
        services: svcChanges,
        namespaces: nsEntries.map(([ns, pos]) => ({ namespace: ns, x: pos.x, y: pos.y })),
      })
      // Update discard baselines (refs only — no state update, no re-render)
      const svcMap = new Map(svcChanges.map(s => [`${s.namespace}::${s.service_name}`, s]))
      savedServiceLayoutsRef.current = savedServiceLayoutsRef.current.map(
        l => { const u = svcMap.get(`${l.namespace}::${l.service_name}`); return u ? { ...l, x: u.x, y: u.y } : l }
      )
      for (const [ns, pos] of nsEntries) savedNsPositionsRef.current[ns] = pos
      for (const svc of svcChanges) pendingLayouts.current.delete(`${svc.namespace}/${svc.service_name}`)
      clearLayoutDraft()
      setLayoutSaveStatus('saved')
      setTimeout(() => setLayoutSaveStatus(s => s === 'saved' ? 'idle' : s), 2000)
    } catch {
      setLayoutSaveStatus('error')
      setTimeout(() => setLayoutSaveStatus(s => s === 'error' ? 'idle' : s), 4000)
    }
  }, [])

  useEffect(() => { autosaveRef.current = autosave && currentUser?.role === 'admin' }, [autosave, currentUser])

  // After user identity is known: restore admin draft or clear non-admin stale draft
  const didInitUserLayout = useRef(false)
  useEffect(() => {
    if (!currentUser || didInitUserLayout.current) return
    didInitUserLayout.current = true
    const draft = loadLayoutDraft()
    if (draft) {
      // Any role: restore draft over DB positions
      setServiceLayouts(prev => prev.map(l => {
        const d = draft.services[`${l.namespace}/${l.service_name}`]
        return d ? { ...l, x: d.x, y: d.y } : l
      }))
      for (const [ns, pos] of Object.entries(draft.namespaces)) {
        pendingNsChanges.current[ns] = pos
      }
      setSavedNsPositions(prev => ({ ...prev, ...draft.namespaces }))
      for (const [k, pos] of Object.entries(draft.services)) {
        const [namespace, service_name] = k.split('/')
        if (namespace && service_name) pendingServiceChanges.current.set(k, { namespace, service_name, x: pos.x, y: pos.y })
      }
      setLayoutSaveStatus('draft')
    }
    // No draft → DB state already loaded from first refresh(), nothing to do
  }, [currentUser])

  const scheduleAutosave = useCallback(() => {
    setLayoutSaveStatus('saving')
    if (!autosaveRef.current) {
      // Non-admin: save to sessionStorage, then transition to 'draft' after 600 ms of inactivity
      const draft: LayoutDraft = { services: {}, namespaces: {} }
      for (const [k, v] of pendingServiceChanges.current) draft.services[k] = { x: v.x, y: v.y }
      for (const [ns, pos] of Object.entries(pendingNsChanges.current)) draft.namespaces[ns] = pos
      saveLayoutDraft(draft)
      if (draftTimerRef.current) clearTimeout(draftTimerRef.current)
      draftTimerRef.current = setTimeout(() => setLayoutSaveStatus('draft'), 600)
      return
    }
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
    autosaveTimerRef.current = setTimeout(flushAutosave, 500)
  }, [flushAutosave])

  useEffect(() => { configRef.current = config }, [config])
  useEffect(() => { currentUserRef.current = currentUser }, [currentUser])
  useEffect(() => {
    if (!currentUser) return
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission()
    }
  }, [currentUser])

  useEffect(() => {
    getMe().then(setCurrentUser).catch(() => { window.location.href = '/login' })
    refresh()
    getConfig()
      .then(cfg => { setConfig(cfg); configRef.current = cfg })
      .catch(() => {})
      .finally(() => setConfigLoaded(true))
    const timer = setInterval(refresh, POLL_INTERVAL)
    return () => clearInterval(timer)
  }, [refresh])

  useEffect(() => {
    let es: EventSource
    let retryTimer: ReturnType<typeof setTimeout>
    let retryDelay = 1000
    let cancelled = false

    function connect() {
      if (cancelled) return
      es = new EventSource('/api/events')
      es.onmessage = (e) => {
        retryDelay = 1000
        refresh()
        try {
          const event = JSON.parse(e.data)
          if (event.type === 'approval_created') {
            const user = currentUserRef.current
            if (!user || event.created_by === user.id) return
            const approvers: Array<{ id: string }> = event.allowed_approvers ?? []
            const canApprove = user.role === 'admin'
              || (approvers.length === 0 && user.role === 'ns_admin')
              || approvers.some((a) => a.id === user.id)
            if (!canApprove) return
            setShowApprovalToast(true)
            if ('Notification' in window && Notification.permission === 'granted') {
              new Notification('Floodgate — Nova aprovação', {
                body: 'Uma policy aguarda sua aprovação.',
                icon: '/favicon.ico',
              })
            }
          }
        } catch {}
      }
      es.onerror = () => {
        es.close()
        retryDelay = Math.min(retryDelay * 2, 30000)
        retryTimer = setTimeout(connect, retryDelay)
      }
    }

    connect()
    return () => {
      cancelled = true
      clearTimeout(retryTimer)
      es?.close()
    }
  }, [refresh])

  function toggleNamespace(ns: string) {
    setVisibleNamespaces(prev => {
      const next = new Set(prev)
      if (next.has(ns)) next.delete(ns)
      else next.add(ns)
      saveHiddenToStorage(new Set(allNamespaces.filter(n => !next.has(n))))
      return next
    })
  }

  function showAllNamespaces() {
    const all = new Set(allNamespaces)
    setVisibleNamespaces(all)
    saveHiddenToStorage(new Set())
  }

  function addDraft(d: Omit<Draft, 'id'>) {
    setDrafts(prev => {
      const exists = prev.some(x =>
        x.src_workload === d.src_workload && x.src_namespace === d.src_namespace &&
        x.dst_service === d.dst_service && x.dst_namespace === d.dst_namespace
      )
      if (exists) return prev
      return [...prev, { ...d, id: `${Date.now()}-${Math.random()}` }]
    })
    const alreadyExists = drafts.some(x =>
      x.src_workload === d.src_workload && x.src_namespace === d.src_namespace &&
      x.dst_service === d.dst_service && x.dst_namespace === d.dst_namespace
    )
    if (!alreadyExists) setRequestTab('drafts')
  }

  function removeDraft(id: string) {
    setDrafts(prev => prev.filter(d => d.id !== id))
  }

  function updateDraftPorts(id: string, ports: Draft['dst_ports']) {
    setDrafts(prev => prev.map(d => d.id === id ? { ...d, dst_ports: ports } : d))
  }

  async function applyDraft(draft: Draft, allowedApprovers: Array<{ id: string; username: string }> = []) {
    if (config.approval_enabled) {
      const { id: _id, ...draftData } = draft
      await createApprovalRequest(draftData, allowedApprovers)
      removeDraft(draft.id)
      return
    }
    if (draft.src_cidr || draft.dst_cidr) {
      await createCidrPolicy({
        namespace: draft.dst_namespace,
        service_name: draft.dst_service || undefined,
        cidr: (draft.src_cidr ?? draft.dst_cidr)!,
        except: draft.cidr_except,
        dst_ports: draft.dst_ports.length > 0 ? draft.dst_ports : undefined,
        direction: draft.src_cidr ? 'ingress' : 'egress',
      })
      removeDraft(draft.id)
      await refresh()
      return
    }
    const req = {
      src_workload: draft.src_workload, src_namespace: draft.src_namespace,
      dst_service: draft.dst_service, dst_namespace: draft.dst_namespace, dst_ports: draft.dst_ports,
    }
    if (draft.policy_direction === 'ingress' || draft.policy_direction === 'both') await createNetworkPolicy(req)
    if (draft.policy_direction === 'egress'  || draft.policy_direction === 'both') await createEgressNetworkPolicy(req)
    removeDraft(draft.id)
    await refresh()
  }

  function discardAllDrafts() {
    setDrafts([])
  }

  async function applyAllDrafts() {
    if (config.approval_enabled) {
      await Promise.all(drafts.map(async d => {
        const { id: _id, ...draftData } = d
        await createApprovalRequest(draftData, [])
      }))
      setDrafts([])
      return
    }
    await Promise.all(drafts.map(async d => {
      if (d.src_cidr || d.dst_cidr) {
        await createCidrPolicy({
          namespace: d.dst_namespace,
          service_name: d.dst_service || undefined,
          cidr: (d.src_cidr ?? d.dst_cidr)!,
          except: d.cidr_except,
          dst_ports: d.dst_ports.length > 0 ? d.dst_ports : undefined,
          direction: d.src_cidr ? 'ingress' : 'egress',
        })
        return
      }
      const req = {
        src_workload: d.src_workload, src_namespace: d.src_namespace,
        dst_service: d.dst_service, dst_namespace: d.dst_namespace, dst_ports: d.dst_ports,
      }
      if (d.policy_direction === 'ingress' || d.policy_direction === 'both') await createNetworkPolicy(req)
      if (d.policy_direction === 'egress'  || d.policy_direction === 'both') await createEgressNetworkPolicy(req)
    }))
    setDrafts([])
    await refresh()
  }

  async function saveConfig(cfg: AppConfig) {
    const saved = await updateConfig(cfg)
    setConfig(saved)
  }

  async function handleLogout() {
    await logout()
    window.location.href = '/login'
  }

  const visibleServices = services.filter(s => visibleNamespaces.has(s.namespace))
  const canManageNamespace = useCallback((namespace: string) => {
    if (!currentUser) return false
    if (currentUser.role === 'admin') return true
    if (currentUser.role === 'ns_admin') return currentUser.allowed_namespaces.includes(namespace)
    return false
  }, [currentUser])

  async function handleServiceMove(req: { namespace: string; service_name: string; x: number; y: number }) {
    setServiceLayouts(prev => {
      const idx = prev.findIndex(p => p.namespace === req.namespace && p.service_name === req.service_name)
      if (idx === -1) return [...prev, { id: '', ...req, locked: false, updated_by: '', updated_at: '' }]
      const next = [...prev]; next[idx] = { ...next[idx], x: req.x, y: req.y }; return next
    })
    const key = `${req.namespace}/${req.service_name}`
    pendingLayouts.current.set(key, { x: req.x, y: req.y })
    pendingServiceChanges.current.set(key, req)
    scheduleAutosave()
  }

  async function handleNsMove(ns: string, pos: { x: number; y: number }) {
    setLocalNsPositions(prev => ({ ...prev, [ns]: pos }))
    pendingNsChanges.current[ns] = pos
    scheduleAutosave()
  }

  async function handleSaveLayout() {
    if (autosaveTimerRef.current) { clearTimeout(autosaveTimerRef.current); autosaveTimerRef.current = null }
    const svcChanges = [...pendingServiceChanges.current.values()]
    const nsEntries = Object.entries(pendingNsChanges.current)
    pendingServiceChanges.current.clear()
    pendingNsChanges.current = {}
    setLayoutSaveStatus('saving')
    try {
      const svcs = serviceLayouts.map(l => ({ namespace: l.namespace, service_name: l.service_name, x: l.x, y: l.y }))
      const nss = Object.entries(localNsPositions).map(([namespace, pos]) => ({ namespace, x: pos.x, y: pos.y }))
      await saveAllLayout({ services: svcs, namespaces: nss })
      savedServiceLayoutsRef.current = serviceLayouts
      savedNsPositionsRef.current = { ...localNsPositions }
      pendingLayouts.current.clear()
      clearLayoutDraft()
      setLayoutSaveStatus('saved')
      setTimeout(() => setLayoutSaveStatus(s => s === 'saved' ? 'idle' : s), 2000)
    } catch {
      for (const s of svcChanges) pendingServiceChanges.current.set(`${s.namespace}/${s.service_name}`, s)
      for (const [ns, pos] of nsEntries) pendingNsChanges.current[ns] = pos
      setLayoutSaveStatus('error')
      setTimeout(() => setLayoutSaveStatus(s => s === 'error' ? 'idle' : s), 4000)
    }
  }

  function handleDiscardLayout() {
    if (autosaveTimerRef.current) { clearTimeout(autosaveTimerRef.current); autosaveTimerRef.current = null }
    if (draftTimerRef.current)    { clearTimeout(draftTimerRef.current);    draftTimerRef.current = null }
    pendingServiceChanges.current.clear()
    pendingNsChanges.current = {}
    pendingLayouts.current.clear()
    clearLayoutDraft()
    setServiceLayouts(savedServiceLayoutsRef.current)
    setLocalNsPositions(savedNsPositionsRef.current)
    setSavedNsPositions(savedNsPositionsRef.current)
    setLayoutSaveStatus('idle')
    setLayoutResetKey(k => k + 1)
  }

  function handleToggleAutosave() {
    const next = !autosave
    try { localStorage.setItem(LS_AUTOSAVE_KEY, String(next)) } catch {}
    if (!next) {
      // Turning OFF: cancel the pending DB flush and save whatever is pending to localStorage instead
      if (autosaveTimerRef.current) { clearTimeout(autosaveTimerRef.current); autosaveTimerRef.current = null }
      if (pendingServiceChanges.current.size > 0 || Object.keys(pendingNsChanges.current).length > 0) {
        const draft: LayoutDraft = { services: {}, namespaces: {} }
        for (const [k, v] of pendingServiceChanges.current) draft.services[k] = { x: v.x, y: v.y }
        for (const [ns, pos] of Object.entries(pendingNsChanges.current)) draft.namespaces[ns] = pos
        saveLayoutDraft(draft)
      }
    }
    setAutosave(next)
  }

  async function handleGlobalLock(locked: boolean) {
    await setGlobalLayoutLock(locked)
    setGlobalLayoutLocked(locked)
  }

  async function handleToggleNamespaceLock(namespace: string, locked: boolean) {
    await setNamespaceLayoutLock(namespace, locked)
    setNamespaceLocks(prev => ({ ...prev, [namespace]: locked }))
  }

  const handleAutoLayoutServices = useCallback(async (
    items: Array<{ namespace: string; service_name: string; x: number; y: number }>,
    namespaces: Array<{ namespace: string; x: number; y: number }> = []
  ) => {
    if (items.length === 0 && namespaces.length === 0) return

    const applyItems = (prev: ServiceLayout[]): ServiceLayout[] => {
      const map = new Map(items.map(i => [`${i.namespace}::${i.service_name}`, i]))
      const existingKeys = new Set(prev.map(l => `${l.namespace}::${l.service_name}`))
      const updated = prev.map(l => { const u = map.get(`${l.namespace}::${l.service_name}`); return u ? { ...l, x: u.x, y: u.y } : l })
      for (const item of items) {
        if (!existingKeys.has(`${item.namespace}::${item.service_name}`))
          updated.push({ id: '', ...item, locked: false, updated_by: '', updated_at: '' })
      }
      return updated
    }
    setServiceLayouts(applyItems)
    for (const item of items) {
      const key = `${item.namespace}/${item.service_name}`
      pendingLayouts.current.set(key, { x: item.x, y: item.y })
      pendingServiceChanges.current.set(key, item)
    }
    if (namespaces.length > 0) {
      setLocalNsPositions(prev => {
        const next = { ...prev }
        for (const ns of namespaces) next[ns.namespace] = { x: ns.x, y: ns.y }
        return next
      })
      for (const ns of namespaces) pendingNsChanges.current[ns.namespace] = { x: ns.x, y: ns.y }
    }
    if (autosaveTimerRef.current) { clearTimeout(autosaveTimerRef.current); autosaveTimerRef.current = null }
    setLayoutSaveStatus('saving')
    if (!autosaveRef.current) {
      const draft: LayoutDraft = { services: {}, namespaces: {} }
      for (const [k, v] of pendingServiceChanges.current) draft.services[k] = { x: v.x, y: v.y }
      for (const [ns, pos] of Object.entries(pendingNsChanges.current)) draft.namespaces[ns] = pos
      saveLayoutDraft(draft)
    }
  }, [])

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#f8fafc' }}>
      {showApprovalToast && (
        <div style={{
          position: 'fixed', top: 16, right: 16, zIndex: 9999,
          background: 'white', borderRadius: 10, boxShadow: '0 4px 24px rgba(0,0,0,0.14)',
          border: '1px solid #fef08a', padding: '12px 14px',
          display: 'flex', alignItems: 'center', gap: 12, minWidth: 290,
        }}>
          <div style={{ width: 34, height: 34, borderRadius: '50%', background: '#fef9c3', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ca8a04" strokeWidth="2" strokeLinecap="round">
              <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>
            </svg>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#1e293b' }}>Nova solicitação de aprovação</div>
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
              {pendingApprovals.length > 0 ? `${pendingApprovals.length} pendente(s) aguardando aprovação` : 'Uma policy aguarda sua aprovação'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              onClick={() => { setRequestTab('aprovacoes'); setShowApprovalToast(false) }}
              style={{ border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600, padding: '5px 10px', background: '#185FA5', color: 'white' }}
            >
              Ver
            </button>
            <button
              onClick={() => setShowApprovalToast(false)}
              style={{ border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 11, fontWeight: 600, padding: '5px 10px', background: '#f1f5f9', color: '#64748b' }}
            >
              ✕
            </button>
          </div>
        </div>
      )}
      <header style={{
        background: 'white', borderBottom: '1px solid #e2e8f0',
        padding: '0 20px', height: 60,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
      }}>
        {/* Brand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <FloodgateLogoIcon size={36} />
          <div>
            <div style={{ fontSize: 25, fontWeight: 500, letterSpacing: '0px', lineHeight: 1.15 }}>
              <span style={{ color: '#042C53' }}>flood</span><span style={{ color: '#185FA5' }}>gate</span>
            </div>
            <div style={{ fontSize: 6.5, color: '#adb5bd', letterSpacing: '1.8px', fontWeight: 600, marginTop: 1, textTransform: 'uppercase' }}>NetworkPolicy Manager</div>
          </div>
        </div>

        {/* Stats + actions */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {/* Stat pills */}
          {[
            { value: visibleServices.length, label: 'serviços',  color: '#185FA5', bg: '#eff6ff' },
            { value: policies.length,        label: 'policies',  color: '#059669', bg: '#f0fdf4' },
            { value: drafts.length,          label: 'rascunhos', color: '#d97706', bg: '#fffbeb' },
          ].map(({ value, label, color, bg }) => (
            <span key={label} style={{
              background: bg, color, fontSize: 11, fontWeight: 600,
              padding: '3px 10px', borderRadius: 20, letterSpacing: '0.01em',
            }}>
              {value} {label}
            </span>
          ))}

          {/* Sync status pill — only when autosync has drift data */}
          {autosyncStatus && autosyncStatus.desired_count > 0 && autosyncStatus.drift !== null && (() => {
            const missing = autosyncStatus.drift?.missing?.length ?? 0
            const inSync = missing === 0
            return (
              <span title={inSync ? 'Todas as policies rastreadas estão no cluster' : `${missing} policy(s) ausente(s) no cluster`} style={{
                display: 'flex', alignItems: 'center', gap: 5,
                background: inSync ? '#f0fdf4' : '#fef2f2',
                color: inSync ? '#059669' : '#dc2626',
                fontSize: 11, fontWeight: 700,
                padding: '3px 10px', borderRadius: 20,
                border: `1px solid ${inSync ? '#bbf7d0' : '#fecaca'}`,
                cursor: 'default',
              }}>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  {inSync
                    ? <polyline points="20 6 9 17 4 12"/>
                    : <><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></>
                  }
                </svg>
                {inSync ? 'Em sync' : `${missing} fora de sync`}
              </span>
            )
          })()}

          {/* Layout controls */}
          {currentUser && (currentUser.role === 'admin' || currentUser.role === 'ns_admin') && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, paddingRight: 8, borderRight: '1px solid #e2e8f0' }}>
              {/* Global lock */}
              <button
                onClick={() => handleGlobalLock(!globalLayoutLocked)}
                title={globalLayoutLocked ? 'Layout bloqueado — clique para desbloquear' : 'Bloquear layout (ninguém arrasta)'}
                style={{
                  width: 30, height: 30, borderRadius: 7, border: `1px solid ${globalLayoutLocked ? '#fbbf24' : '#e2e8f0'}`,
                  background: globalLayoutLocked ? '#fffbeb' : 'none', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: globalLayoutLocked ? '#d97706' : '#94a3b8',
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                  {globalLayoutLocked
                    ? <><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></>
                    : <><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/></>
                  }
                </svg>
              </button>
              {/* Save status spinner — always visible when saving/saved/error */}
              <SaveSpinner status={layoutSaveStatus} />
            </div>
          )}

          {/* Refresh */}
          <button
            onClick={refresh}
            title={lastUpdate ? `Atualizado ${lastUpdate.toLocaleTimeString()}` : 'Atualizar'}
            style={{
              background: 'none', border: '1px solid #e2e8f0', borderRadius: 8,
              width: 32, height: 32, cursor: 'pointer', color: '#94a3b8',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              marginLeft: 4,
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = '#185FA5'; e.currentTarget.style.color = '#185FA5' }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = '#e2e8f0'; e.currentTarget.style.color = '#94a3b8' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
          </button>

          {/* User section */}
          {currentUser && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 8, paddingLeft: 14, borderLeft: '1px solid #e2e8f0' }}>
              {/* Icon links */}
              {currentUser.role === 'admin' && (
                <a href="/users" title="Usuários" style={{
                  width: 32, height: 32, borderRadius: 8, border: '1px solid #e2e8f0',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: '#64748b', textDecoration: 'none', transition: 'all 0.15s',
                }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = '#185FA5'; e.currentTarget.style.color = '#185FA5' }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = '#e2e8f0'; e.currentTarget.style.color = '#64748b' }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>
                  </svg>
                </a>
              )}
              {(currentUser.role === 'admin' || currentUser.role === 'audit') && (
                <a href="/audit" title="Audit log" style={{
                  width: 32, height: 32, borderRadius: 8, border: '1px solid #e2e8f0',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: '#64748b', textDecoration: 'none', transition: 'all 0.15s',
                }}
                  onMouseEnter={e => { e.currentTarget.style.borderColor = '#185FA5'; e.currentTarget.style.color = '#185FA5' }}
                  onMouseLeave={e => { e.currentTarget.style.borderColor = '#e2e8f0'; e.currentTarget.style.color = '#64748b' }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
                    <line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
                  </svg>
                </a>
              )}

              {/* Avatar + name — clica para trocar senha */}
              <button
                onClick={() => setOpenPasswordModal(true)}
                title="Trocar senha"
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  background: 'none', border: '1px solid transparent', borderRadius: 8,
                  padding: '3px 6px', cursor: 'pointer', transition: 'all 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = '#e2e8f0'; e.currentTarget.style.background = '#f8fafc' }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'transparent'; e.currentTarget.style.background = 'none' }}
              >
                <div style={{
                  width: 30, height: 30, borderRadius: '50%',
                  background: currentUser.role === 'admin' ? '#185FA5' : currentUser.role === 'audit' ? '#c2410c' : '#475569',
                  color: 'white', fontSize: 11, fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  letterSpacing: 0, flexShrink: 0,
                }}>
                  {currentUser.username.slice(0, 2).toUpperCase()}
                </div>
                <div style={{ textAlign: 'left' }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#0f172a', lineHeight: 1.2 }}>{currentUser.username}</div>
                  <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
                    color: currentUser.role === 'admin' ? '#185FA5' : currentUser.role === 'audit' ? '#c2410c' : '#64748b' }}>
                    {currentUser.role}
                  </div>
                </div>
              </button>

              {/* Logout */}
              <button
                onClick={handleLogout}
                title="Sair"
                style={{
                  width: 32, height: 32, borderRadius: 8, border: '1px solid #e2e8f0',
                  background: 'none', cursor: 'pointer', color: '#94a3b8',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'all 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = '#fca5a5'; e.currentTarget.style.color = '#dc2626' }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = '#e2e8f0'; e.currentTarget.style.color = '#94a3b8' }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
                </svg>
              </button>
            </div>
          )}
        </div>
      </header>

      {error && (
        <div style={{ background: '#fef2f2', borderBottom: '1px solid #fecaca', padding: '6px 20px', fontSize: 11, color: '#dc2626' }}>
          {error}
        </div>
      )}

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        <RightPanel
          currentUser={currentUser}
          allNamespaces={allNamespaces}
          services={services}
          policies={policies}
          allPolicies={allPolicies}
          drafts={drafts}
          visibleNamespaces={visibleNamespaces}
          config={config}
          configLoaded={configLoaded}
          onToggleNamespace={toggleNamespace}
          onRemoveDraft={removeDraft}
          onAddDraft={addDraft}
          onApplyDraft={(draft, approvers) => applyDraft(draft, approvers)}
          onApplyAllDrafts={applyAllDrafts}
          onDiscardAllDrafts={discardAllDrafts}
          onUpdateDraftPort={updateDraftPorts}
          onPoliciesChanged={refresh}
          onSaveConfig={saveConfig}
          pendingApprovals={pendingApprovals}
          requestTab={requestTab}
          onTabOpened={() => setRequestTab(null)}
          openPasswordModal={openPasswordModal}
          onPasswordModalClosed={() => setOpenPasswordModal(false)}
          ciliumFlows={ciliumFlows}
          ciliumStreaming={ciliumStreaming}
          onClearCiliumFlows={() => clearCiliumFlows().then(() => setCiliumFlows([])).catch(() => {})}
        />
        <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
          {visibleNamespaces.size > 0 && visibleNamespaces.size < allNamespaces.length && (
            <div style={{
              position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
              zIndex: 10, display: 'flex', alignItems: 'center', gap: 8,
              background: '#fffbeb', border: '1px solid #f59e0b', borderRadius: 20,
              padding: '5px 8px 5px 12px', fontSize: 12, color: '#92400e',
              boxShadow: '0 2px 8px rgba(0,0,0,0.1)', whiteSpace: 'nowrap',
              pointerEvents: 'auto',
            }}>
              <span>
                {allNamespaces.length - visibleNamespaces.size === 1
                  ? '1 namespace oculto — conexões não exibidas'
                  : `${allNamespaces.length - visibleNamespaces.size} namespaces ocultos — conexões não exibidas`}
              </span>
              <button
                onClick={showAllNamespaces}
                style={{
                  background: '#f59e0b', border: 'none', borderRadius: 12,
                  padding: '3px 10px', fontSize: 11, color: '#fff',
                  cursor: 'pointer', fontWeight: 600,
                }}
              >
                Exibir todos
              </button>
            </div>
          )}
          <NetworkGraph
            services={visibleServices}
            policies={policies}
            drafts={drafts}
            pendingApprovals={pendingApprovals}
            layoutSaveStatus={layoutSaveStatus}
            serviceLayouts={serviceLayouts}
            namespaceLocks={namespaceLocks}
            nsPositionsFromDB={savedNsPositions}
            layoutResetKey={layoutResetKey}
            globalLocked={globalLayoutLocked}
            isViewer={currentUser?.role === 'viewer' || currentUser?.role === 'audit'}
            isAdmin={currentUser?.role === 'admin'}
            canManageNamespace={canManageNamespace}
            onServiceMove={handleServiceMove}
            onNsMove={handleNsMove}
            onAutoLayoutServices={handleAutoLayoutServices}
            onToggleNamespaceLock={handleToggleNamespaceLock}
            autosave={currentUser?.role === 'admin' ? autosave : false}
            onToggleAutosave={currentUser?.role === 'admin' ? handleToggleAutosave : undefined}
            onSaveLayout={currentUser?.role === 'admin' ? handleSaveLayout : undefined}
            onDiscardLayout={handleDiscardLayout}
            onAddDraft={addDraft}
            onRemoveDraft={removeDraft}
            onPolicyChanged={refresh}
            ciliumFlows={ciliumFlows}
            ciliumStreaming={ciliumStreaming}
            ignoredNamespaces={config.ignored_namespaces}
            visibleNamespaces={visibleNamespaces}
          />
        </div>
      </div>
    </div>
  )
}
