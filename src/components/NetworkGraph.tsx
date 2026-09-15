'use client'

import React, { useCallback, useEffect, useRef } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Panel,
  useNodesState,
  useEdgesState,
  useReactFlow,
  getViewportForBounds,
  type Connection,
  type Node,
  type Edge,
  type BuiltInEdge,
  type NodeTypes,
  type NodeProps,
  type NodeChange,
  Handle,
  Position,
  applyNodeChanges,
} from '@xyflow/react'
import { toPng } from 'html-to-image'
import dagre from '@dagrejs/dagre'
import { ServiceInfo, NetworkPolicyInfo, Draft, PortSpec, ServiceLayout, ApprovalRequest, CiliumFlowSummary } from '@/types'
import { deleteNetworkPolicy, restrictService, patchNetworkPolicyPort, isolateNamespace } from '@/api/client'
import { explainAccess, type ExplainResult } from '@/lib/explainAccess'
import { normalizeWorkload } from '@/lib/flowMatch'

// ─── Namespace group node ──────────────────────────────────────────────────
const ShieldIcon = ({ color }: { color: string }) => (
  <svg width="9" height="9" viewBox="0 0 24 24" fill={color} stroke="none">
    <path d="M12 2L3 7v5c0 5.25 3.75 10.15 9 11.35C17.25 22.15 21 17.25 21 12V7L12 2z"/>
  </svg>
)

function IsolationBadge({ isolatedIn, isolatedEg, exceptionCount }: {
  isolatedIn: boolean
  isolatedEg: boolean
  exceptionCount: number
}) {
  if (!isolatedIn && !isolatedEg) return (
    <span
      title="Namespace sem isolamento: tráfego irrestrito"
      style={{ display: 'inline-flex', alignItems: 'center', color: '#cbd5e1', flexShrink: 0 }}
    >
      <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
        <path d="M12 2L3 7v5c0 5.25 3.75 10.15 9 11.35C17.25 22.15 21 17.25 21 12V7L12 2z"/>
      </svg>
    </span>
  )

  const full = isolatedIn && isolatedEg
  if (full) {
    const hasEx = exceptionCount > 0
    return (
      <span
        title={hasEx
          ? `Isolada com ${exceptionCount} ${exceptionCount === 1 ? 'exceção' : 'exceções'}: clique para ver`
          : 'Namespace totalmente fechada: default-deny em ingress e egress'
        }
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 2,
          fontSize: 9, fontWeight: 700,
          background: '#fef2f2',
          color: '#b91c1c',
          border: '1px solid #fecaca',
          borderRadius: 99,
          padding: '1px 5px', whiteSpace: 'nowrap', flexShrink: 0,
        }}
      >
        <ShieldIcon color="#b91c1c" />
        {hasEx && <span>{exceptionCount}</span>}
      </span>
    )
  }

  // Partial isolation: minimal arrows, no text, always red like full isolation
  return (
    <span style={{ display: 'inline-flex', gap: 2, flexShrink: 0 }}>
      {isolatedIn && (
        <span
          title="Ingress isolado: default-deny namespace-wide para tráfego de entrada"
          style={{
            fontSize: 9, fontWeight: 700,
            background: '#fef2f2', color: '#b91c1c',
            border: '1px solid #fecaca', borderRadius: 99,
            padding: '1px 4px', whiteSpace: 'nowrap',
          }}
        >↙</span>
      )}
      {isolatedEg && (
        <span
          title="Egress isolado: default-deny namespace-wide para tráfego de saída"
          style={{
            fontSize: 9, fontWeight: 700,
            background: '#fef2f2', color: '#b91c1c',
            border: '1px solid #fecaca', borderRadius: 99,
            padding: '1px 4px', whiteSpace: 'nowrap',
          }}
        >↗</span>
      )}
    </span>
  )
}

function NamespaceGroupNode({ data, selected }: NodeProps) {
  const [headerHovered, setHeaderHovered] = React.useState(false)
  const d = data as {
    label: string
    color: string
    borderColor: string
    locked: boolean
    canToggleLock: boolean
    onToggleLock: () => void
    isolatedIn: boolean
    isolatedEg: boolean
    exceptionCount: number
    virtual?: boolean
  }
  const fullyIsolated = d.isolatedIn && d.isolatedEg
  const partiallyIsolated = d.isolatedIn || d.isolatedEg
  return (
    <div style={{
      width: '100%', height: '100%', borderRadius: 10, boxSizing: 'border-box',
      border: `2px ${d.virtual ? 'dashed' : 'solid'} ${selected ? d.borderColor : d.borderColor + '99'}`,
      backgroundColor: d.color,
      opacity: d.virtual ? 0.75 : 1,
      cursor: 'pointer',
      boxShadow: selected
        ? `0 0 0 3px ${d.borderColor}33`
        : fullyIsolated
          ? '0 0 0 3px #fca5a566, 0 2px 8px rgba(185,28,28,0.15)'
          : partiallyIsolated
            ? '0 0 0 2px #fca5a555'
            : 'none',
      transition: 'box-shadow 0.15s',
    }}>
      <Handle type="target" position={Position.Left}
        isConnectable={false}
        style={{ opacity: 0, pointerEvents: 'none', width: 8, height: 8 }} />
      <div
        onMouseEnter={() => setHeaderHovered(true)}
        onMouseLeave={() => setHeaderHovered(false)}
        style={{
          padding: '6px 12px', fontSize: 11, fontWeight: 700, color: d.borderColor,
          letterSpacing: '0.08em', textTransform: 'uppercase',
          borderBottom: `1px solid ${d.borderColor}25`, userSelect: 'none',
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={d.borderColor} strokeWidth="2.5" style={{ opacity: 0.6, flexShrink: 0 }}>
          <path d="M5 9l4-4 4 4M5 15l4 4 4-4M15 9l4-4 4 4M15 15l4 4 4-4" />
        </svg>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.label}</span>
        {d.virtual && (
          <span style={{ fontSize: 9, color: '#94a3b8', fontWeight: 400, whiteSpace: 'nowrap', fontStyle: 'italic' }}>descoberto</span>
        )}
        {!d.virtual && <IsolationBadge isolatedIn={d.isolatedIn} isolatedEg={d.isolatedEg} exceptionCount={d.exceptionCount} />}
        <button
          onClick={e => { e.stopPropagation(); if (d.canToggleLock) d.onToggleLock() }}
          disabled={!d.canToggleLock}
          title={d.locked ? 'Clique para desbloquear serviços' : 'Clique para travar posição dos serviços'}
          style={{
            border: `1px solid ${d.borderColor}55`,
            background: 'white',
            color: d.borderColor,
            borderRadius: 999,
            width: 20, height: 20,
            fontSize: 11,
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            cursor: d.canToggleLock ? 'pointer' : 'not-allowed',
            opacity: d.locked ? 0.7 : headerHovered && d.canToggleLock ? 0.9 : 0,
            pointerEvents: headerHovered || d.locked ? 'auto' : 'none',
            lineHeight: 1, padding: 0, flexShrink: 0,
            transition: 'opacity 0.15s',
          }}
        >
          {d.locked ? '🔒' : '🔓'}
        </button>
      </div>
      <Handle type="source" position={Position.Right}
        isConnectable={false}
        style={{ opacity: 0, pointerEvents: 'none', width: 8, height: 8 }} />
    </div>
  )
}

// ─── Service node ──────────────────────────────────────────────────────────
function TrafficIndicator({ denied, title }: { denied: boolean; title: string }) {
  return (
    <div title={title} style={{
      width: 14, height: 14, borderRadius: '50%', flexShrink: 0,
      background: denied ? '#fee2e2' : '#dcfce7',
      border: `1.5px solid ${denied ? '#ef4444' : '#22c55e'}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 8, color: denied ? '#ef4444' : '#22c55e', fontWeight: 900,
    }}>
      {denied ? '✕' : '✓'}
    </div>
  )
}

function ServiceNodeComponent({ data, selected }: NodeProps) {
  const d = data as { name: string; ports: Array<{ port: number }>; ingressDenied: boolean; egressDenied: boolean }
  const portList = d.ports.slice(0, 3).map(p => p.port).join(', ')
  return (
    <div style={{
      background: selected ? '#eff6ff' : 'white',
      border: `2px solid ${selected ? '#3b82f6' : '#cbd5e1'}`,
      borderRadius: 8, padding: '6px 10px', minWidth: 150,
      boxShadow: selected ? '0 0 0 3px #bfdbfe' : '0 1px 4px rgba(0,0,0,0.08)',
      transition: 'all 0.15s',
    }}>
      <Handle type="target" position={Position.Left} style={{ background: d.ingressDenied ? '#ef4444' : '#94a3b8', width: 10, height: 10 }} />
      <div style={{ fontSize: 12, fontWeight: 700, color: '#1e293b', whiteSpace: 'nowrap' }}>{d.name}</div>
      {portList && <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 1 }}>:{portList}</div>}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
        <TrafficIndicator denied={d.ingressDenied} title={d.ingressDenied ? 'Inbound: default-deny ativo' : 'Inbound: aberto'} />
        <TrafficIndicator denied={d.egressDenied}  title={d.egressDenied  ? 'Outbound: default-deny ativo' : 'Outbound: aberto'} />
      </div>
      <Handle type="source" position={Position.Right} style={{ background: d.egressDenied ? '#ef4444' : '#3b82f6', width: 10, height: 10 }} />
    </div>
  )
}

function WorkloadNodeComponent({ data }: NodeProps) {
  const d = data as { label: string }
  return (
    <div style={{
      background: '#f1f5f9', border: '1.5px solid #94a3b8', borderRadius: 8,
      padding: '6px 10px', fontSize: 11, color: '#475569', fontWeight: 500,
      display: 'flex', alignItems: 'center', gap: 6, minWidth: 120,
    }}>
      <Handle type="target" position={Position.Left}
        isConnectable={false} style={{ opacity: 0, pointerEvents: 'none', width: 8, height: 8 }} />
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0 }}>
        <rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v2"/>
      </svg>
      <span title={d.label} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 }}>
        {d.label}
      </span>
      <Handle type="source" position={Position.Right}
        isConnectable={false} style={{ opacity: 0, pointerEvents: 'none', width: 8, height: 8 }} />
    </div>
  )
}

const nodeTypes: NodeTypes = { namespace: NamespaceGroupNode, service: ServiceNodeComponent, workload: WorkloadNodeComponent }

// ─── Palette ───────────────────────────────────────────────────────────────
const PALETTE = [
  { bg: 'rgba(59,130,246,0.06)',  border: '#3b82f6' },
  { bg: 'rgba(16,185,129,0.06)', border: '#10b981' },
  { bg: 'rgba(245,158,11,0.06)', border: '#f59e0b' },
  { bg: 'rgba(139,92,246,0.06)', border: '#8b5cf6' },
  { bg: 'rgba(236,72,153,0.06)', border: '#ec4899' },
  { bg: 'rgba(239,68,68,0.06)',  border: '#ef4444' },
]

// ─── Layout constants ──────────────────────────────────────────────────────
const NODE_W = 160, NODE_H = 56, NODE_GAPH = 20, NODE_GAPV = 16
const NS_PAD = 20, NS_HEADER = 34
const TREE_COL_GAP = 130, TREE_ROW_GAP = 70

function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
  pad = 0,
) {
  return !(
    a.x + a.w + pad <= b.x ||
    b.x + b.w + pad <= a.x ||
    a.y + a.h + pad <= b.y ||
    b.y + b.h + pad <= a.y
  )
}

// ─── Multi-edge curvature helper ───────────────────────────────────────────
function assignCurvatures(rawEdges: Array<{ srcId: string; dstId: string; key: string }>) {
  const pairCount = new Map<string, number>()
  const pairIdx   = new Map<string, number>()
  const pairKey   = (a: string, b: string) => [a, b].sort().join('|||')

  rawEdges.forEach(({ srcId, dstId }) => {
    const k = pairKey(srcId, dstId)
    pairCount.set(k, (pairCount.get(k) ?? 0) + 1)
  })

  return rawEdges.map(({ srcId, dstId, key }) => {
    const k     = pairKey(srcId, dstId)
    const total = pairCount.get(k) ?? 1
    const idx   = pairIdx.get(k) ?? 0
    pairIdx.set(k, idx + 1)
    const base   = 0.25
    const spread = 0.35
    const offset = total === 1 ? 0 : (idx / (total - 1) - 0.5) * spread * 2
    return { key, curvature: base + offset }
  })
}

// ─── Tree layout (topological sort, left-to-right) ────────────────────────
function computeNamespaceTreeLayout(
  namespaces: string[],
  nsSizes: Map<string, { w: number; h: number }>,
  policies: NetworkPolicyInfo[],
  drafts: Draft[],
  ciliumFlows: CiliumFlowSummary[],
): Map<string, { x: number; y: number }> {
  // Layered graph layout (rank assignment, cycle breaking, multi-pass
  // crossing minimization, dummy nodes for edges spanning multiple ranks)
  // is a well-solved problem — dagre is the layout engine React Flow's own
  // examples use for exactly this, so we hand it off instead of maintaining
  // a hand-rolled version of the same algorithm.
  const nsSet = new Set(namespaces)
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'LR', nodesep: TREE_ROW_GAP, ranksep: TREE_COL_GAP })
  g.setDefaultEdgeLabel(() => ({}))

  for (const ns of namespaces) {
    const { w, h } = nsSizes.get(ns) ?? { w: 200, h: 100 }
    g.setNode(ns, { width: w, height: h })
  }

  const seenPair = new Set<string>()
  const addEdge = (src: string, dst: string) => {
    if (src === dst || !nsSet.has(src) || !nsSet.has(dst)) return
    const key = `${src}->${dst}`
    if (seenPair.has(key)) return
    seenPair.add(key)
    g.setEdge(src, dst)
  }
  for (const p of policies) addEdge(p.src_namespace, p.namespace)
  for (const d of drafts)   addEdge(d.src_namespace, d.dst_namespace)
  // Real observed traffic counts too — without it, namespaces with no
  // policy yet (only Hubble flows) have no edges at all and collapse into
  // a single rank/column, disconnected from the lines actually drawn.
  for (const f of ciliumFlows) addEdge(f.src_namespace, f.dst_namespace)

  dagre.layout(g)

  // dagre positions nodes by center; the rest of this file treats a
  // namespace's {x,y} as its top-left corner.
  const positions = new Map<string, { x: number; y: number }>()
  for (const ns of namespaces) {
    const node = g.node(ns)
    const { w, h } = nsSizes.get(ns) ?? { w: 200, h: 100 }
    positions.set(ns, node ? { x: node.x - w / 2, y: node.y - h / 2 } : { x: 0, y: 0 })
  }

  // A line between two connected namespaces is drawn straight from center to
  // center. If an unrelated namespace's box happens to sit near that straight
  // path, the line cuts right through it. Detect that directly — for every
  // namespace-pair edge, check every other box against the segment between
  // the two endpoints — and nudge the box vertically until it's clear,
  // iterating since one nudge can create a new conflict with another edge.
  const rectOf = (ns: string) => {
    const pos = positions.get(ns)!
    const { w, h } = nsSizes.get(ns) ?? { w: 200, h: 100 }
    return { x: pos.x, y: pos.y, w, h }
  }
  const centerOf = (ns: string) => {
    const r = rectOf(ns)
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 }
  }
  const CLEARANCE = 26

  for (let pass = 0; pass < 6; pass++) {
    let moved = false
    for (const key of seenPair) {
      const [a, b] = key.split('->')
      if (!nsSet.has(a) || !nsSet.has(b)) continue
      const ca = centerOf(a), cb = centerOf(b)
      if (Math.abs(ca.x - cb.x) < 1) continue // same column, no diagonal path to worry about
      for (const c of namespaces) {
        if (c === a || c === b) continue
        const rect = rectOf(c)
        const cx = rect.x + rect.w / 2
        const xLo = Math.min(ca.x, cb.x), xHi = Math.max(ca.x, cb.x)
        if (cx <= xLo + 1 || cx >= xHi - 1) continue // c's column isn't between a and b
        const t = (cx - ca.x) / (cb.x - ca.x)
        const lineY = ca.y + t * (cb.y - ca.y)
        const cy = rect.y + rect.h / 2
        const minDist = rect.h / 2 + CLEARANCE
        const dist = Math.abs(lineY - cy)
        if (dist < minDist) {
          const dir = cy >= lineY ? 1 : -1
          const pos = positions.get(c)!
          positions.set(c, { ...pos, y: pos.y + dir * (minDist - dist + 4) })
          moved = true
        }
      }
    }
    if (!moved) break
  }

  // Nudging boxes away from lines can push two of them into each other —
  // separate any that now overlap.
  for (let i = 0; i < namespaces.length; i++) {
    for (let j = i + 1; j < namespaces.length; j++) {
      const a = namespaces[i], b = namespaces[j]
      const ra = rectOf(a), rb = rectOf(b)
      if (!rectsOverlap(ra, rb, 16)) continue
      const pa = positions.get(a)!, pb = positions.get(b)!
      const overlapY = (ra.h + rb.h) / 2 + 16 - Math.abs((ra.y + ra.h / 2) - (rb.y + rb.h / 2))
      const push = Math.max(overlapY / 2, 10)
      if (pa.y <= pb.y) {
        positions.set(a, { ...pa, y: pa.y - push })
        positions.set(b, { ...pb, y: pb.y + push })
      } else {
        positions.set(a, { ...pa, y: pa.y + push })
        positions.set(b, { ...pb, y: pb.y - push })
      }
    }
  }

  return positions
}

// ─── Build graph ───────────────────────────────────────────────────────────
function buildGraph(
  services: ServiceInfo[],
  policies: NetworkPolicyInfo[],
  drafts: Draft[],
  pendingApprovals: ApprovalRequest[],
  serviceLayouts: ServiceLayout[],
  namespaceLocks: Record<string, boolean>,
  onToggleNamespaceLock: ((namespace: string, locked: boolean) => Promise<void>) | undefined,
  nsPositions: Map<string, { x: number; y: number }>,
  nsPaletteIdx: Map<string, number>,
  canManageNamespace: ((namespace: string) => boolean) | undefined,
  layoutMode: 'namespaces' | 'services' | 'both' = 'both',
  globalLocked = false,
  ciliumFlows: CiliumFlowSummary[] = [],
  showFlowEdges = false,
  ignoredNamespaces: string[] = [],
  visibleNamespaces?: Set<string>,
): { nodes: Node[]; edges: BuiltInEdge[] } {
  const nsVisible = (ns: string) =>
    !visibleNamespaces || visibleNamespaces.size === 0 || visibleNamespaces.has(ns)
  const visibleFlows = ciliumFlows.filter(
    f => nsVisible(f.src_namespace) && nsVisible(f.dst_namespace)
  )

  const nsMap = new Map<string, ServiceInfo[]>()
  for (const svc of services) {
    if (!nsMap.has(svc.namespace)) nsMap.set(svc.namespace, [])
    nsMap.get(svc.namespace)!.push(svc)
  }

  const nsSizes = new Map<string, { w: number; h: number }>()
  for (const [ns, svcs] of nsMap) {
    const cols = Math.max(1, Math.ceil(Math.sqrt(svcs.length)))
    const rows = Math.ceil(svcs.length / cols)
    nsSizes.set(ns, {
      w: cols * (NODE_W + NODE_GAPH) - NODE_GAPH + NS_PAD * 2,
      h: NS_HEADER + NS_PAD + rows * (NODE_H + NODE_GAPV) - NODE_GAPV + NS_PAD,
    })
  }

  {
    const tree = computeNamespaceTreeLayout([...nsMap.keys()], nsSizes, policies, drafts, showFlowEdges ? visibleFlows : [])
    // Remove stale namespaces that no longer exist in the cluster
    for (const key of [...nsPositions.keys()]) {
      if (!nsMap.has(key)) nsPositions.delete(key)
    }
    // Only assign tree positions to namespaces not already positioned (preserves manual drags)
    for (const [ns, pos] of tree) {
      if (!nsPositions.has(ns)) nsPositions.set(ns, pos)
    }
  }

  // Order services within each namespace box by the average X position of
  // the OTHER namespaces they connect to — same barycenter idea as the
  // namespace columns above, one level deeper. Services with similar
  // connections end up next to each other instead of scattered across the
  // grid, so their edges converge on one side of the box instead of fanning
  // out across the whole thing.
  {
    const svcNsNeighbors = new Map<string, Set<string>>()
    const addSvcNsNeighbor = (ns: string, svcName: string, otherNs: string) => {
      if (ns === otherNs || !svcName) return
      const key = `${ns}::${svcName}`
      if (!svcNsNeighbors.has(key)) svcNsNeighbors.set(key, new Set())
      svcNsNeighbors.get(key)!.add(otherNs)
    }
    for (const p of policies.filter(p => p.managed && p.src_workload)) {
      addSvcNsNeighbor(p.namespace, p.dst_service, p.src_namespace)
      addSvcNsNeighbor(p.src_namespace, p.src_workload, p.namespace)
    }
    for (const f of visibleFlows) {
      addSvcNsNeighbor(f.dst_namespace, f.dst_workload, f.src_namespace)
      addSvcNsNeighbor(f.src_namespace, f.src_workload, f.dst_namespace)
    }
    const NO_SVC_SCORE = Number.MAX_SAFE_INTEGER
    const svcScore = (ns: string, svcName: string): number => {
      const neighbors = svcNsNeighbors.get(`${ns}::${svcName}`)
      if (!neighbors || neighbors.size === 0) return NO_SVC_SCORE
      const xs = [...neighbors].map(n => nsPositions.get(n)?.x ?? 0)
      return xs.reduce((a, b) => a + b, 0) / xs.length
    }
    for (const [ns, svcs] of nsMap) {
      svcs.sort((a, b) => svcScore(ns, a.name) - svcScore(ns, b.name))
    }
  }

  const groupNodes: Node[]   = []
  const serviceNodes: Node[] = []
  let autoIdx = 0

  const ingressDeniedSet = new Set(
    policies.filter(p => p.policy_type === 'restrict-ingress').map(p => `${p.namespace}::${p.dst_service}`)
  )
  const egressDeniedSet = new Set(
    policies.filter(p => p.policy_type === 'restrict-egress').map(p => `${p.namespace}::${p.dst_service}`)
  )
  // Namespace-wide isolation: restrict policy with empty dst_service (podSelector: {})
  const nsIsolatedIngress = new Set(
    policies.filter(p => p.policy_type === 'restrict-ingress' && p.dst_service === '').map(p => p.namespace)
  )
  const nsIsolatedEgress = new Set(
    policies.filter(p => p.policy_type === 'restrict-egress' && p.dst_service === '').map(p => p.namespace)
  )
  // Exception count per namespace: services with explicit allow inside an isolated namespace
  const nsExceptionCount = new Map<string, number>()
  for (const [ns] of nsMap) {
    if (!nsIsolatedIngress.has(ns) && !nsIsolatedEgress.has(ns)) continue
    const withIngress = new Set(
      policies
        .filter(p => p.namespace === ns && (p.policy_type === 'allow' || p.policy_type === 'allow-namespace') && p.dst_service !== '')
        .map(p => p.dst_service)
    )
    const withEgress = new Set(
      policies
        .filter(p => p.namespace === ns && p.policy_type === 'allow-egress' && p.src_workload !== '')
        .map(p => p.src_workload)
    )
    const allExcepted = new Set([...withIngress, ...withEgress])
    nsExceptionCount.set(ns, allExcepted.size)
  }
  const layoutMap = new Map(serviceLayouts.map(l => [`${l.namespace}::${l.service_name}`, l]))

  for (const [ns, svcs] of nsMap) {
    const { w: nsW, h: nsH } = nsSizes.get(ns)!
    const cols = Math.max(1, Math.ceil(Math.sqrt(svcs.length)))

    if (!nsPaletteIdx.has(ns)) nsPaletteIdx.set(ns, autoIdx++ % PALETTE.length)
    const p = PALETTE[nsPaletteIdx.get(ns)!]

    if (!nsPositions.has(ns)) {
      nsPositions.set(ns, { x: 0, y: [...nsPositions.values()].reduce((m, v) => Math.max(m, v.y), 0) + nsH + TREE_ROW_GAP })
    }
    const pos = nsPositions.get(ns)!
    const nsLocked = namespaceLocks[ns] ?? false
    const canToggleLock = !!canManageNamespace?.(ns)

    groupNodes.push({
      id: `ns::${ns}`,
      type: 'namespace',
      position: pos,
      style: { width: nsW, height: nsH, padding: 0 },
      data: {
        label: ns,
        color: p.bg,
        borderColor: p.border,
        locked: nsLocked,
        canToggleLock,
        onToggleLock: () => onToggleNamespaceLock?.(ns, !nsLocked),
        isolatedIn: nsIsolatedIngress.has(ns),
        isolatedEg: nsIsolatedEgress.has(ns),
        exceptionCount: nsExceptionCount.get(ns) ?? 0,
      },
      draggable: !globalLocked,
      zIndex: 0,
    })

    svcs.forEach((svc, i) => {
      const col = i % cols, row = Math.floor(i / cols)
      const key = `${ns}::${svc.name}`
      const saved = layoutMode === 'namespaces' ? layoutMap.get(key) : undefined
      serviceNodes.push({
        id: `svc::${ns}::${svc.name}`,
        type: 'service',
        parentId: `ns::${ns}`,
        extent: 'parent',
        position: saved
          ? { x: saved.x, y: saved.y }
          : { x: NS_PAD + col * (NODE_W + NODE_GAPH), y: NS_HEADER + NS_PAD + row * (NODE_H + NODE_GAPV) },
        data: { name: svc.name, namespace: ns, ports: svc.ports, ingressDenied: ingressDeniedSet.has(key), egressDenied: egressDeniedSet.has(key) },
        draggable: !globalLocked && !nsLocked && svcs.length > 1,
        zIndex: 10,
      })
    })
  }

  const nodes: Node[] = [...groupNodes, ...serviceNodes]
  const svcSet = new Set(serviceNodes.map(n => n.id))
  const nsGroupSet = new Set(groupNodes.map(n => n.id))
  const workloadSet = new Set<string>()

  // Cria nós virtuais para namespaces que aparecem em flows mas não têm K8s Services
  if (showFlowEdges && visibleFlows.length > 0) {
    const VIRTUAL_W = NS_PAD * 2 + NODE_W   // 200px: largura mínima legível
    const WORKLOAD_H = 36
    const maxY = groupNodes.length > 0
      ? Math.max(...groupNodes.map(n => n.position.y + ((n.style?.height as number) ?? 0)))
      : 0
    let vCol = 0
    const seen = new Set<string>()

    for (const flow of visibleFlows) {
      for (const namespace of [flow.src_namespace, flow.dst_namespace]) {
        const nsId = `ns::${namespace}`
        if (nsGroupSet.has(nsId) || seen.has(nsId)) continue
        if (ignoredNamespaces.includes(namespace)) continue
        seen.add(nsId)

        // Coletar workloads únicos deste namespace sem Service K8s
        const nsWorkloads = new Set<string>()
        for (const f of visibleFlows) {
          if (f.src_namespace === namespace && !svcSet.has(`svc::${namespace}::${f.src_workload}`))
            nsWorkloads.add(normalizeWorkload(f.src_workload))
          if (f.dst_namespace === namespace && !svcSet.has(`svc::${namespace}::${f.dst_workload}`))
            nsWorkloads.add(normalizeWorkload(f.dst_workload))
        }
        const workloadList = [...nsWorkloads].sort()
        const VIRTUAL_H_DYN = NS_HEADER + NS_PAD + workloadList.length * (WORKLOAD_H + 6) + NS_PAD

        const savedPos = nsPositions.get(namespace)
        const pos = savedPos ?? { x: vCol * (VIRTUAL_W + TREE_COL_GAP), y: maxY + TREE_ROW_GAP }
        if (!savedPos) nsPositions.set(namespace, pos)
        if (!nsPaletteIdx.has(namespace)) nsPaletteIdx.set(namespace, autoIdx++ % PALETTE.length)

        nodes.push({
          id: nsId,
          type: 'namespace',
          position: pos,
          style: { width: VIRTUAL_W, height: VIRTUAL_H_DYN, padding: 0 },
          data: {
            label: namespace,
            color: '#f8fafc',
            borderColor: '#94a3b8',
            locked: false,
            canToggleLock: false,
            onToggleLock: () => undefined,
            isolatedIn: false,
            isolatedEg: false,
            exceptionCount: 0,
            virtual: true,
          },
          draggable: !globalLocked,
          zIndex: 0,
        })
        nsGroupSet.add(nsId)

        // Nós de workload como filhos do grupo virtual
        workloadList.forEach((wl, i) => {
          const wlId = `work::${namespace}::${wl}`
          workloadSet.add(wlId)
          nodes.push({
            id: wlId,
            type: 'workload',
            parentId: nsId,
            extent: 'parent' as const,
            position: { x: NS_PAD, y: NS_HEADER + NS_PAD + i * (WORKLOAD_H + 6) },
            style: { width: VIRTUAL_W - NS_PAD * 2 },
            data: { label: wl },
            draggable: false,
            zIndex: 1,
          })
        })

        vCol++
      }
    }
  }

  // ── Pré-coleta do flowPairMap (antes de assignCurvatures p/ integrar curvatura) ──
  const nsSvcNames = new Map<string, string[]>()
  for (const nodeId of svcSet) {
    const parts = nodeId.split('::')
    const ns = parts[1], name = parts[2]
    if (!nsSvcNames.has(ns)) nsSvcNames.set(ns, [])
    nsSvcNames.get(ns)!.push(name)
  }
  function resolveNodeId(namespace: string, workload: string): string | null {
    const exact = `svc::${namespace}::${workload}`
    if (svcSet.has(exact)) return exact
    const candidates = nsSvcNames.get(namespace) ?? []
    const fwd = candidates.find(s => workload.startsWith(s + '-') || workload.startsWith(s + '_'))
    if (fwd) return `svc::${namespace}::${fwd}`
    const rev = candidates.find(s => s.startsWith(workload + '-') || s.startsWith(workload + '_'))
    if (rev) return `svc::${namespace}::${rev}`
    const wlId = `work::${namespace}::${normalizeWorkload(workload)}`
    if (workloadSet.has(wlId)) return wlId
    const nsId = `ns::${namespace}`
    if (nsGroupSet.has(nsId)) return nsId
    return null
  }
  const flowPairMap = new Map<string, { flow: CiliumFlowSummary; srcId: string; dstId: string; ports: Set<number> }>()
  if (showFlowEdges && visibleFlows.length > 0) {
    for (const flow of visibleFlows) {
      const srcId = resolveNodeId(flow.src_namespace, flow.src_workload)
      const dstId = resolveNodeId(flow.dst_namespace, flow.dst_workload)
      if (!srcId || !dstId || srcId === dstId) continue
      const pairKey = `${srcId}→${dstId}::${flow.verdict}`
      const entry = flowPairMap.get(pairKey)
      if (entry) {
        entry.ports.add(flow.dst_port)
        if (new Date(flow.last_seen) > new Date(entry.flow.last_seen)) entry.flow = flow
      } else {
        flowPairMap.set(pairKey, { flow, srcId, dstId, ports: new Set([flow.dst_port]) })
      }
    }
  }

  // ── Conjuntos para lógica UX semântica (Fix 3) ──────────────────────────
  // Pares cobertos por policies gerenciadas
  const policyNodePairs = new Set<string>()
  for (const policy of policies.filter(p => p.managed && p.src_workload)) {
    const srcId = `svc::${policy.src_namespace}::${policy.src_workload}`
    const dstId = `svc::${policy.namespace}::${policy.dst_service}`
    if (svcSet.has(srcId) && svcSet.has(dstId)) policyNodePairs.add(`${srcId}|${dstId}`)
  }
  // Pares com tráfego FORWARDED recente (para animar policy edges)
  const activeFlowPairs = new Set<string>()
  for (const [, { srcId, dstId, flow }] of flowPairMap) {
    if (flow.verdict === 'FORWARDED') activeFlowPairs.add(`${srcId}|${dstId}`)
  }

  const rawEdges: Array<{ srcId: string; dstId: string; key: string }> = []

  for (const policy of policies.filter(p => p.managed && p.src_workload)) {
    const srcId = `svc::${policy.src_namespace}::${policy.src_workload}`
    const dstId = `svc::${policy.namespace}::${policy.dst_service}`
    rawEdges.push({ srcId, dstId, key: `policy::${policy.name}` })
  }
  for (const draft of drafts) {
    const srcId = `svc::${draft.src_namespace}::${draft.src_workload}`
    const dstId = `svc::${draft.dst_namespace}::${draft.dst_service}`
    if (!svcSet.has(srcId) || !svcSet.has(dstId)) continue
    rawEdges.push({ srcId, dstId, key: `draft::${draft.id}` })
  }
  for (const apr of pendingApprovals) {
    const d = apr.draft_data as Draft
    const srcId = `svc::${d.src_namespace}::${d.src_workload}`
    const dstId = `svc::${d.dst_namespace}::${d.dst_service}`
    if (!svcSet.has(srcId) || !svcSet.has(dstId)) continue
    rawEdges.push({ srcId, dstId, key: `approval::${apr.id}` })
  }
  // Flow edges integradas no cálculo de curvatura
  for (const [pairKey, { srcId, dstId }] of flowPairMap) {
    rawEdges.push({ srcId, dstId, key: `flow::${pairKey}` })
  }

  const curvatureMap = new Map(
    assignCurvatures(rawEdges).map(({ key, curvature }) => [key, curvature])
  )

  const edges: BuiltInEdge[] = []

  for (const policy of policies.filter(p => p.managed && p.src_workload)) {
    if (!nsVisible(policy.src_namespace) || !nsVisible(policy.namespace)) continue
    const srcId = `svc::${policy.src_namespace}::${policy.src_workload}`
    const dstId = `svc::${policy.namespace}::${policy.dst_service}`
    const id    = `policy::${policy.name}`
    const cur   = curvatureMap.get(id) ?? 0.25
    const isEgress = policy.policy_type === 'allow-egress'
    // Anima a policy edge quando Hubble confirma tráfego ativo no par
    const isActive = showFlowEdges && activeFlowPairs.has(`${srcId}|${dstId}`)
    const color = isEgress ? '#8b5cf6' : '#10b981'
    edges.push({
      id, source: srcId, target: dstId, type: 'default',
      animated: isActive,
      pathOptions: { curvature: cur },
      style: {
        stroke: color,
        strokeWidth: isActive ? 3 : 2.5,
        filter: isActive ? `drop-shadow(0 0 4px ${color}99)` : undefined,
      },
      label: `${isEgress ? 'egress' : 'ingress'} :${policy.dst_port}`,
      labelStyle: { fontSize: 10, fill: isEgress ? '#5b21b6' : '#065f46' },
      labelBgStyle: { fill: 'white', opacity: 0.9 },
      markerEnd: { type: 'arrowclosed' as const, color },
      data: { type: 'policy', policy }, zIndex: 20,
    })
  }

  for (const draft of drafts) {
    const srcId = `svc::${draft.src_namespace}::${draft.src_workload}`
    const dstId = `svc::${draft.dst_namespace}::${draft.dst_service}`
    if (!svcSet.has(srcId) || !svcSet.has(dstId)) continue
    const id  = `draft::${draft.id}`
    const cur = curvatureMap.get(id) ?? 0.25
    edges.push({
      id, source: srcId, target: dstId, type: 'default',
      animated: true,
      pathOptions: { curvature: cur },
      style: { stroke: '#f97316', strokeWidth: 2, strokeDasharray: '8 4' },
      label: `rascunho: ${draft.dst_ports.length === 0 ? 'liberado todas as portas' : draft.dst_ports.map(p => `${p.protocol !== 'TCP' ? p.protocol + '/' : ''}${p.port}${p.endPort ? `-${p.endPort}` : ''}`).join(', ')}`,
      labelStyle: { fontSize: 10, fill: '#c2410c', fontWeight: 700 },
      labelBgStyle: { fill: '#fff7ed', opacity: 0.95 },
      markerEnd: { type: 'arrowclosed' as const, color: '#f97316' },
      data: { type: 'draft', draft }, zIndex: 20,
    })
  }

  for (const apr of pendingApprovals) {
    const d = apr.draft_data as Draft
    const srcId = `svc::${d.src_namespace}::${d.src_workload}`
    const dstId = `svc::${d.dst_namespace}::${d.dst_service}`
    if (!svcSet.has(srcId) || !svcSet.has(dstId)) continue
    const id  = `approval::${apr.id}`
    const cur = curvatureMap.get(id) ?? 0.25
    const approvedCount = apr.approve_count ?? 0
    const required = apr.approvals_required ?? 1
    const quorum = `${approvedCount}/${required}`
    edges.push({
      id, source: srcId, target: dstId, type: 'default',
      animated: true,
      pathOptions: { curvature: cur },
      style: { stroke: '#eab308', strokeWidth: 2.5, strokeDasharray: '6 3' },
      label: `pendente ${quorum}: ${(d.dst_ports ?? []).length === 0 ? 'todas as portas' : d.dst_ports.map(p => `${p.protocol !== 'TCP' ? p.protocol + '/' : ''}${p.port}${p.endPort ? `-${p.endPort}` : ''}`).join(', ')}`,
      labelStyle: { fontSize: 10, fill: '#854d0e', fontWeight: 700 },
      labelBgStyle: { fill: '#fefce8', opacity: 0.97 },
      markerEnd: { type: 'arrowclosed' as const, color: '#eab308' },
      data: { type: 'approval', approval: apr }, zIndex: 20,
    })
  }

  // Flow edges: FORWARDED coberto por policy → absorvido na policy animada (sem linha dupla)
  // Só aparecem: FORWARDED sem policy (azul = sem regra!) e DROPPED (vermelho = bloqueado)
  for (const [pairKey, { flow, srcId, dstId, ports }] of flowPairMap) {
    const isDropped = flow.verdict === 'DROPPED'
    if (!isDropped && policyNodePairs.has(`${srcId}|${dstId}`)) continue
    const id = `flow::${pairKey}`
    const cur = curvatureMap.get(id) ?? 0.25
    const sortedPorts = [...ports].sort((a, b) => a - b)
    const portLabel = sortedPorts.length <= 3
      ? sortedPorts.join(',')
      : `${sortedPorts.slice(0, 3).join(',')}+${sortedPorts.length - 3}`
    const ageMs = Date.now() - new Date(flow.last_seen).getTime()
    const opacity = ageMs < 2 * 60 * 1000 ? 0.9 : ageMs < 15 * 60 * 1000 ? 0.65 : 0.35
    edges.push({
      id, source: srcId, target: dstId, type: 'default',
      animated: true,
      pathOptions: { curvature: cur },
      style: {
        stroke: isDropped ? '#dc2626' : '#3b82f6',
        strokeWidth: isDropped ? 2 : 1.5,
        strokeDasharray: isDropped ? '4 3' : undefined,
        opacity,
      },
      label: `${isDropped ? '✗' : '↓'} :${portLabel}`,
      labelStyle: { fontSize: 9, fill: isDropped ? '#991b1b' : '#1e40af' },
      labelBgStyle: { fill: 'white', opacity: 0.8 },
      markerEnd: { type: 'arrowclosed' as const, color: isDropped ? '#dc2626' : '#3b82f6' },
      data: { type: 'flow', flow },
      zIndex: 15,
    })
  }

  return { nodes, edges }
}

// ─── Service detail panel ──────────────────────────────────────────────────
type ConnEntry = {
  label: string
  ports: number[]
  status: 'policy' | 'policy-egress' | 'draft'
}

function buildConnections(
  name: string, ns: string,
  policies: NetworkPolicyInfo[], drafts: Draft[],
) {
  const inbound:  Map<string, ConnEntry> = new Map()
  const outbound: Map<string, ConnEntry> = new Map()

  const upsert = (map: Map<string, ConnEntry>, key: string, label: string, port: number, status: ConnEntry['status']) => {
    const prev = map.get(key)
    if (!prev) { map.set(key, { label, ports: [port], status }); return }
    if (!prev.ports.includes(port)) prev.ports.push(port)
    const rank = { policy: 3, 'policy-egress': 3, draft: 1 }
    if (rank[status] > rank[prev.status]) prev.status = status
  }

  for (const p of policies) {
    if (p.policy_type === 'allow' && p.dst_service === name && p.namespace === ns)
      upsert(inbound, `${p.src_namespace}/${p.src_workload}`, `${p.src_workload} (${p.src_namespace})`, p.dst_port, 'policy')
    if (p.policy_type === 'allow-egress' && p.src_workload === name && p.src_namespace === ns)
      upsert(outbound, `${p.namespace}/${p.dst_service}`, `${p.dst_service} (${p.namespace})`, p.dst_port, 'policy-egress')
  }
  for (const d of drafts) {
    if (d.dst_service === name && d.dst_namespace === ns)
      upsert(inbound, `${d.src_namespace}/${d.src_workload}`, `${d.src_workload} (${d.src_namespace})`, d.dst_ports[0]?.port ?? 0, 'draft')
    if (d.src_workload === name && d.src_namespace === ns)
      upsert(outbound, `${d.dst_namespace}/${d.dst_service}`, `${d.dst_service} (${d.dst_namespace})`, d.dst_ports[0]?.port ?? 0, 'draft')
  }

  return { inbound: [...inbound.values()], outbound: [...outbound.values()] }
}

const STATUS_META: Record<ConnEntry['status'], { color: string; bg: string; label: string }> = {
  policy:        { color: '#10b981', bg: '#f0fdf4', label: 'Ingress allow' },
  'policy-egress': { color: '#8b5cf6', bg: '#f5f3ff', label: 'Egress allow' },
  draft:         { color: '#f97316', bg: '#fff7ed', label: 'Rascunho' },
}

// ─── Access section (status badge + allowed services list) ────────────────
const smallBtn = (danger = false): React.CSSProperties => ({
  marginTop: 5, padding: '3px 9px', fontSize: 9, fontWeight: 700,
  border: `1px solid ${danger ? '#fca5a5' : '#93c5fd'}`,
  borderRadius: 5, cursor: 'pointer',
  background: danger ? '#fff1f2' : '#eff6ff',
  color: danger ? '#dc2626' : '#2563eb',
})

function AccessSection({
  direction, restrictPolicy, connections, explain, isViewer, onRestrict, onRemoveRestrict,
}: {
  direction: 'Inbound' | 'Outbound'
  restrictPolicy: NetworkPolicyInfo | undefined
  connections: ConnEntry[]
  explain: ExplainResult
  isViewer?: boolean
  onRestrict: () => void
  onRemoveRestrict: () => void
}) {
  const dir = direction === 'Inbound' ? 'ingress' : 'egress'
  const blocked = !!restrictPolicy
  const hasAllows = connections.length > 0
  const [showWhy, setShowWhy] = React.useState(false)

  let icon: string, statusColor: string, bg: string, border: string
  if (explain.scope !== 'none' && explain.exceptions.length > 0) {
    icon = '🔒'; statusColor = '#15803d'; bg = '#f0fdf4'; border = '#bbf7d0'
  } else if (explain.scope !== 'none') {
    icon = '🔒'; statusColor = '#b91c1c'; bg = '#fef2f2'; border = '#fecaca'
  } else if (explain.blocked) {
    icon = '🔒'; statusColor = '#b91c1c'; bg = '#fef2f2'; border = '#fecaca'
  } else {
    icon = '⚠️'; statusColor = '#dc2626'; bg = '#fef2f2'; border = '#fecaca'
  }
  const statusText = explain.headline

  return (
    <div>
      <div style={{ fontSize: 9, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 5 }}>
        {direction === 'Inbound' ? '↙' : '↗'} {direction}
      </div>

      <div style={{ padding: '7px 10px', borderRadius: 7, background: bg, border: `1px solid ${border}` }}>
        <div
          onClick={() => setShowWhy(v => !v)}
          title="Clique para ver por quê"
          role="button"
          tabIndex={0}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setShowWhy(v => !v) }}
          style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}
        >
          <span style={{ fontSize: 11 }}>{icon}</span>
          <span style={{ fontSize: 10, fontWeight: 700, color: statusColor, flex: 1 }}>{statusText}</span>
          <span
            style={{
              width: 16, height: 16, borderRadius: '50%', flexShrink: 0,
              border: `1px solid ${statusColor}`, background: 'transparent', color: statusColor,
              fontSize: 9, fontWeight: 900, lineHeight: 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
          >
            ?
          </span>
        </div>
        {showWhy && (
          <div style={{ marginTop: 6, paddingTop: 6, borderTop: `1px solid ${border}`, display: 'flex', flexDirection: 'column', gap: 3 }}>
            {explain.detail.map((line, i) => (
              <div key={i} style={{ fontSize: 9.5, color: '#475569' }}>{line}</div>
            ))}
          </div>
        )}
        {!blocked && !hasAllows && (
          <div style={{ fontSize: 9, color: '#b91c1c', marginTop: 2 }}>
            {dir === 'ingress' ? 'Qualquer pod pode acessar qualquer porta.' : 'Pode alcançar qualquer destino.'}
          </div>
        )}
        {!isViewer && (
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 4 }}>
            {blocked
              ? <button style={smallBtn(true)} onClick={onRemoveRestrict}>Remover default-deny</button>
              : <button style={smallBtn()} onClick={onRestrict}>
                  + {hasAllows ? 'Tornar default-deny explícito' : 'Aplicar default-deny'}
                </button>
            }
          </div>
        )}
      </div>

      {/* Allowed services list */}
      {hasAllows && (
        <div style={{ marginTop: 5 }}>
          {connections.map(e => {
            const m = STATUS_META[e.status]
            return (
              <div key={e.label} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 2px', borderBottom: '1px solid #f8fafc' }}>
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: m.color, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 10, fontWeight: 600, color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.label}</div>
                  <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', marginTop: 1 }}>
                    {e.ports.sort((a, b) => a - b).map(p => (
                      <span key={p} style={{ fontSize: 9, fontWeight: 700, background: m.bg, color: m.color, borderRadius: 3, padding: '1px 4px', border: `1px solid ${m.color}33` }}>:{p}</span>
                    ))}
                  </div>
                </div>
                <span style={{ fontSize: 9, color: m.color, background: m.bg, borderRadius: 3, padding: '2px 5px', border: `1px solid ${m.color}33`, whiteSpace: 'nowrap' }}>
                  {m.label}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ServiceDetailPanel({
  nodeId, services, policies, drafts, isViewer, canManageNamespace, onClose, onPolicyChanged,
}: {
  nodeId: string; services: ServiceInfo[]; policies: NetworkPolicyInfo[]; drafts: Draft[];
  canManageNamespace?: (namespace: string) => boolean
  isViewer?: boolean; onClose: () => void; onPolicyChanged: () => void
}) {
  const parts = nodeId.split('::')
  const ns = parts[1], name = parts[2]
  const canManageCurrent = typeof canManageNamespace === 'function' ? canManageNamespace(ns) : !isViewer
  const svc = services.find(s => s.name === name && s.namespace === ns)
  const { inbound, outbound } = buildConnections(name, ns, policies, drafts)

  const ingressRestrict = policies.find(p => p.dst_service === name && p.namespace === ns && p.policy_type === 'restrict-ingress')
  const egressRestrict  = policies.find(p => p.dst_service === name && p.namespace === ns && p.policy_type === 'restrict-egress')
  const ingressExplain = explainAccess(name, ns, 'ingress', policies)
  const egressExplain  = explainAccess(name, ns, 'egress',  policies)

  async function applyRestrict(direction: 'ingress' | 'egress') {
    await restrictService({ service_name: name, namespace: ns, direction })
    onPolicyChanged()
  }

  async function removeRestrict(policy: NetworkPolicyInfo) {
    await deleteNetworkPolicy(policy.namespace, policy.name)
    onPolicyChanged()
  }

  return (
    <div style={{
      position: 'absolute', top: 12, left: 12, zIndex: 100,
      background: 'white', borderRadius: 12, width: 300,
      boxShadow: '0 4px 24px rgba(0,0,0,0.13)', border: '1px solid #e2e8f0',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0', padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>{name}</div>
          <div style={{ fontSize: 10, color: '#64748b', marginTop: 1 }}>{ns}</div>
          {svc && svc.ports.length > 0 && (
            <div style={{ display: 'flex', gap: 4, marginTop: 4, flexWrap: 'wrap' }}>
              {svc.ports.map(p => (
                <span key={p.port} style={{ fontSize: 9, fontWeight: 700, background: '#eff6ff', color: '#3b82f6', borderRadius: 4, padding: '1px 6px', border: '1px solid #bfdbfe' }}>:{p.port}</span>
              ))}
            </div>
          )}
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 16, lineHeight: 1, padding: 2 }}>✕</button>
      </div>

      {/* Access sections */}
      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 14, maxHeight: 480, overflowY: 'auto' }}>
        <AccessSection
          direction="Inbound"
          restrictPolicy={ingressRestrict}
          connections={inbound}
          explain={ingressExplain}
          isViewer={!canManageCurrent}
          onRestrict={() => applyRestrict('ingress')}
          onRemoveRestrict={() => ingressRestrict && removeRestrict(ingressRestrict)}
        />
        <div style={{ borderTop: '1px solid #f1f5f9' }} />
        <AccessSection
          direction="Outbound"
          restrictPolicy={egressRestrict}
          connections={outbound}
          explain={egressExplain}
          isViewer={!canManageCurrent}
          onRestrict={() => applyRestrict('egress')}
          onRemoveRestrict={() => egressRestrict && removeRestrict(egressRestrict)}
        />
      </div>
    </div>
  )
}

// ─── Flow explain panel: why a Hubble-observed DROPPED flow was blocked ───
function parseServiceNodeId(id: string): { ns: string; name: string } | null {
  const parts = id.split('::')
  return parts[0] === 'svc' ? { ns: parts[1], name: parts[2] } : null
}

// Does this specific flow's source match one of the destination's ingress
// exceptions? Matched by the same label format explainAccess() generates —
// good enough since we control that format ourselves.
function sourceIsExempt(exceptions: ExplainResult['exceptions'], srcNs: string, srcName: string): boolean {
  return exceptions.some(e =>
    e.label === `${srcName} (${srcNs})` || e.label === `todo o namespace ${srcNs}` || e.label === 'pods do mesmo namespace')
}

function FlowExplainPanel({ edge, policies, onClose }: {
  edge: Edge; policies: NetworkPolicyInfo[]; onClose: () => void
}) {
  const flow = edge.data!.flow as CiliumFlowSummary
  const dst = parseServiceNodeId(edge.target)
  const src = parseServiceNodeId(edge.source)
  const dstExplain = dst ? explainAccess(dst.name, dst.ns, 'ingress', policies) : null

  const srcName = src?.name ?? normalizeWorkload(flow.src_workload)
  const srcNs   = src?.ns   ?? flow.src_namespace
  const dstName = dst?.name ?? normalizeWorkload(flow.dst_workload)
  const dstNs   = dst?.ns   ?? flow.dst_namespace

  const exempt = dstExplain ? sourceIsExempt(dstExplain.exceptions, srcNs, srcName) : false

  return (
    <div style={{
      position: 'absolute', top: 12, left: 12, zIndex: 100,
      background: 'white', borderRadius: 12, width: 320,
      boxShadow: '0 4px 24px rgba(0,0,0,0.13)', border: '1px solid #e2e8f0',
      overflow: 'hidden',
    }}>
      <div style={{ background: '#fef2f2', borderBottom: '1px solid #fecaca', padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#991b1b' }}>✗ Fluxo bloqueado (DROPPED)</div>
          <div style={{ fontSize: 10.5, color: '#7f1d1d', marginTop: 3 }}>
            {srcName} ({srcNs}) → {dstName} ({dstNs}) :{flow.dst_port}/{flow.protocol}
          </div>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 16, lineHeight: 1, padding: 2 }}>✕</button>
      </div>

      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10, maxHeight: 420, overflowY: 'auto' }}>
        {dstExplain ? (
          <>
            <div style={{ fontSize: 11, fontWeight: 700, color: exempt ? '#b45309' : '#991b1b' }}>
              {exempt
                ? `${srcName} está na lista de liberados. Se mesmo assim foi bloqueado, pode ser porta/protocolo diferente ou um atraso momentâneo do Cilium.`
                : `${srcName} (${srcNs}) não está liberado para acessar ${dstName} (${dstNs}).`}
            </div>

            <div>
              <div style={{ fontSize: 9, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Motivo</div>
              <div style={{ fontSize: 10.5, color: '#1e293b', fontWeight: 600 }}>{dstExplain.headline}</div>
              {dstExplain.detail.length === 0 && (
                <div style={{ fontSize: 9.5, color: '#64748b', marginTop: 2 }}>Nenhuma exceção configurada: ninguém tem acesso.</div>
              )}
            </div>

            {dstExplain.exceptions.length > 0 && (
              <div>
                <div style={{ fontSize: 9, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>Quem tem acesso liberado</div>
                {dstExplain.exceptions.map((e, i) => (
                  <div key={i} style={{ fontSize: 9.5, color: '#334155', marginTop: 2 }}>✓ {e.label}</div>
                ))}
              </div>
            )}
          </>
        ) : (
          <div style={{ fontSize: 10, color: '#64748b' }}>
            O destino (<strong>{dstName}</strong> em <strong>{dstNs}</strong>) não é um Service do Kubernetes rastreado pelo Floodgate. Pode ser um workload sem Service, ou um namespace inteiro. Verifique as NetworkPolicies desse namespace manualmente.
          </div>
        )}

        <div style={{ fontSize: 9, color: '#94a3b8', background: '#f8fafc', borderRadius: 6, padding: '6px 8px', lineHeight: 1.5 }}>
          Baseado em todas as NetworkPolicies do cluster, inclusive não-gerenciadas pelo Floodgate. O Hubble reporta o bloqueio real do Cilium, que pode vir de qualquer policy.
        </div>
      </div>
    </div>
  )
}

// ─── Namespace detail panel ───────────────────────────────────────────────
function NsDirRow({
  label, nsIsolated, nsPolicy, applying, isViewer, onApply, onRemove,
}: {
  label: string
  nsIsolated: boolean
  nsPolicy: NetworkPolicyInfo | undefined
  applying: boolean
  isViewer?: boolean
  onApply: () => void
  onRemove: (p: NetworkPolicyInfo) => void
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
          : !isViewer && (
            <button disabled={applying} onClick={onApply} style={{
              padding: '3px 9px', fontSize: 9, fontWeight: 700,
              border: '1px solid #93c5fd', borderRadius: 5,
              background: '#eff6ff', color: '#2563eb',
              cursor: applying ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
            }}>
              Aplicar {dir}
            </button>
          )
        }
      </div>
    </div>
  )
}

function NamespaceDetailPanel({
  namespace, services, policies, isViewer, canManageNamespace, onClose, onPolicyChanged,
}: {
  namespace: string; services: ServiceInfo[]; policies: NetworkPolicyInfo[]
  canManageNamespace?: (namespace: string) => boolean
  isViewer?: boolean; onClose: () => void; onPolicyChanged: () => void
}) {
  const [applying, setApplying]           = React.useState(false)
  const [allowIntra, setAllowIntra]       = React.useState(true)
  const [allowInternet, setAllowInternet] = React.useState(true)
  const [result, setResult]               = React.useState<string | null>(null)
  const canManageCurrent = typeof canManageNamespace === 'function' ? canManageNamespace(namespace) : !isViewer

  const total = services.filter(s => s.namespace === namespace).length

  // Namespace-wide isolation policies (target-service is empty = podSelector: {})
  const nsIngressPolicy = policies.find(p =>
    p.namespace === namespace && p.policy_type === 'restrict-ingress' && p.dst_service === ''
  )
  const nsEgressPolicy = policies.find(p =>
    p.namespace === namespace && p.policy_type === 'restrict-egress' && p.dst_service === ''
  )
  const nsIsolatedIn = !!nsIngressPolicy
  const nsIsolatedEg = !!nsEgressPolicy
  const anyIsolated  = nsIsolatedIn || nsIsolatedEg
  const fullyIsolated = nsIsolatedIn && nsIsolatedEg

  // Live option detection: do these bonus policies already exist?
  const hasIntraPolicy    = policies.some(p => p.namespace === namespace && p.policy_type === 'allow-intranamespace')
  const hasInternetPolicy = policies.some(p => p.namespace === namespace && p.policy_type === 'allow-egress' && p.dst_service === 'internet')

  const statusColor = fullyIsolated ? '#15803d' : anyIsolated ? '#d97706' : '#dc2626'
  const statusBg    = fullyIsolated ? '#f0fdf4' : anyIsolated ? '#fffbeb' : '#fef2f2'
  const statusText  = fullyIsolated ? 'Totalmente isolado' : anyIsolated ? 'Parcialmente isolado' : 'Exposto'

  async function apply(direction: 'ingress' | 'egress' | 'both') {
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
    setApplying(true); setResult(null)
    try {
      await deleteNetworkPolicy(p.namespace, p.name)
      // Se não sobrou nenhuma restrict namespace-wide, limpa companions
      const otherRestrict = policies.find(op =>
        op.namespace === namespace &&
        op.name !== p.name &&
        (op.policy_type === 'restrict-ingress' || op.policy_type === 'restrict-egress') &&
        op.dst_service === ''
      )
      if (!otherRestrict) {
        const companions = policies.filter(op =>
          op.namespace === namespace &&
          (op.policy_type === 'allow-intranamespace' ||
           (op.policy_type === 'allow-egress' && op.dst_service === 'internet'))
        )
        await Promise.all(companions.map(op => deleteNetworkPolicy(op.namespace, op.name).catch(() => {})))
      }
      onPolicyChanged()
    } catch {
      setResult('Erro ao remover')
    } finally {
      setApplying(false)
    }
  }

  async function toggleIntra() {
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
    <div style={{
      position: 'absolute', top: 12, left: 12, zIndex: 100,
      background: 'white', borderRadius: 12, width: 300,
      boxShadow: '0 4px 24px rgba(0,0,0,0.13)', border: '1px solid #e2e8f0',
      overflow: 'hidden',
    }}>
      <div style={{ background: '#f8fafc', borderBottom: '1px solid #e2e8f0', padding: '10px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#64748b" strokeWidth="2.5">
              <path d="M5 9l4-4 4 4M5 15l4 4 4-4M15 9l4-4 4 4M15 15l4 4 4-4" />
            </svg>
            <div style={{ fontSize: 13, fontWeight: 700, color: '#0f172a' }}>{namespace}</div>
          </div>
          <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>{total} serviço(s) · regras individuais preservadas</div>
          <div style={{ display: 'inline-block', marginTop: 5, padding: '2px 8px', borderRadius: 10, fontSize: 9, fontWeight: 700, color: statusColor, background: statusBg, border: `1px solid ${statusColor}33` }}>
            {statusText}
          </div>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#94a3b8', fontSize: 16, lineHeight: 1, padding: 2 }}>✕</button>
      </div>

      <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12, maxHeight: 460, overflowY: 'auto' }}>
        <NsDirRow label="Inbound"  nsIsolated={nsIsolatedIn} nsPolicy={nsIngressPolicy} applying={applying} isViewer={!canManageCurrent} onApply={() => apply('ingress')} onRemove={removePolicy} />
        <div style={{ borderTop: '1px solid #f1f5f9' }} />
        <NsDirRow label="Outbound" nsIsolated={nsIsolatedEg} nsPolicy={nsEgressPolicy}  applying={applying} isViewer={!canManageCurrent} onApply={() => apply('egress')}  onRemove={removePolicy} />

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
                    disabled={applying}
                    onClick={toggleIntra}
                    style={{
                      width: 36, height: 20, borderRadius: 10, border: 'none', cursor: applying ? 'not-allowed' : 'pointer',
                      background: hasIntraPolicy ? '#10b981' : '#cbd5e1', position: 'relative', flexShrink: 0, transition: 'background 0.2s', padding: 0,
                    }}
                  >
                    <span style={{ position: 'absolute', top: 2, left: hasIntraPolicy ? 18 : 2, width: 16, height: 16, borderRadius: '50%', background: 'white', transition: 'left 0.2s', display: 'block' }} />
                  </button>
                </div>
                {/* Internet egress toggle: only relevant when egress is isolated */}
                {nsIsolatedEg && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 10px', borderRadius: 7, background: '#f8fafc', border: '1px solid #e2e8f0' }}>
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 600, color: '#334155' }}>Saída para internet</div>
                      <div style={{ fontSize: 9, color: '#94a3b8' }}>Libera egress ports 80/443 (IPs públicos)</div>
                    </div>
                    <button
                      disabled={applying}
                      onClick={toggleInternet}
                      style={{
                        width: 36, height: 20, borderRadius: 10, border: 'none', cursor: applying ? 'not-allowed' : 'pointer',
                        background: hasInternetPolicy ? '#10b981' : '#cbd5e1', position: 'relative', flexShrink: 0, transition: 'background 0.2s', padding: 0,
                      }}
                    >
                      <span style={{ position: 'absolute', top: 2, left: hasInternetPolicy ? 18 : 2, width: 16, height: 16, borderRadius: '50%', background: 'white', transition: 'left 0.2s', display: 'block' }} />
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Pre-apply options: shown only when not fully isolated yet */}
            {!fullyIsolated && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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

            {result && (
              <div style={{ fontSize: 10, color: result.startsWith('Erro') ? '#dc2626' : '#15803d', textAlign: 'center', fontWeight: 600 }}>
                {result}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ─── Edit policy modal ────────────────────────────────────────────────────
function EditPolicyModal({
  policy, onClose, onSaved, onDeleted,
}: {
  policy: NetworkPolicyInfo
  onClose: () => void
  onSaved: () => void
  onDeleted: () => void
}) {
  const [ports, setPorts] = React.useState<PortSpec[]>(
    policy.dst_ports && policy.dst_ports.length > 0 ? policy.dst_ports : [{ port: policy.dst_port || 80, protocol: 'TCP' }]
  )
  const [saving, setSaving] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      await patchNetworkPolicyPort(policy.namespace, policy.name, ports)
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    if (!confirm(`Remover "${policy.name}"?`)) return
    setDeleting(true)
    try {
      await deleteNetworkPolicy(policy.namespace, policy.name)
      onDeleted()
    } finally {
      setDeleting(false)
    }
  }

  const isEgress = policy.policy_type === 'allow-egress'

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
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
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 6, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              {isEgress ? 'Egress' : 'Ingress'} allow
            </div>
            <div style={{ fontSize: 11, color: '#475569' }}>
              <code style={{ background: '#eff6ff', color: '#2563eb', padding: '2px 5px', borderRadius: 4, fontSize: 10 }}>
                {policy.src_namespace}/{policy.src_workload}
              </code>
              <span style={{ margin: '0 6px', color: '#94a3b8' }}>→</span>
              <code style={{ background: '#f0fdf4', color: '#16a34a', padding: '2px 5px', borderRadius: 4, fontSize: 10 }}>
                {policy.namespace}/{policy.dst_service}
              </code>
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: '#475569', marginBottom: 6 }}>
              Portas <span style={{ color: '#94a3b8', fontWeight: 400 }}>(vazio = todas)</span>
            </label>
            {ports.map((ps, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                <select value={ps.protocol} onChange={e => setPorts(prev => prev.map((p, j) => j === i ? { ...p, protocol: e.target.value as PortSpec['protocol'] } : p))}
                  style={{ border: '1px solid #cbd5e1', borderRadius: 6, padding: '6px 8px', fontSize: 12, background: 'white', cursor: 'pointer', flexShrink: 0 }}>
                  <option value="TCP">TCP</option>
                  <option value="UDP">UDP</option>
                  <option value="SCTP">SCTP</option>
                </select>
                <input type="number" value={ps.port} min={1} max={65535}
                  onChange={e => setPorts(prev => prev.map((p, j) => j === i ? { ...p, port: Math.min(65535, Math.max(1, parseInt(e.target.value) || 1)) } : p))}
                  style={{ flex: 1, border: '1px solid #cbd5e1', borderRadius: 6, padding: '6px 8px', fontSize: 13, boxSizing: 'border-box' }} />
                <span style={{ fontSize: 9, color: '#94a3b8', flexShrink: 0 }}>até</span>
                <input type="number" value={ps.endPort ?? ''} min={1} max={65535} placeholder="—"
                  onChange={e => {
                    const v = e.target.value === '' ? undefined : Math.min(65535, Math.max(1, parseInt(e.target.value) || 1))
                    setPorts(prev => prev.map((p, j) => j === i ? { ...p, endPort: v } : p))
                  }}
                  style={{ flex: 1, border: '1px solid #cbd5e1', borderRadius: 6, padding: '6px 8px', fontSize: 13, boxSizing: 'border-box' }} />
                <button onClick={() => setPorts(prev => prev.filter((_, j) => j !== i))}
                  style={{ background: '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 5, cursor: 'pointer', padding: '5px 8px', fontSize: 12 }}>✕</button>
              </div>
            ))}
            <button onClick={() => setPorts(prev => [...prev, { port: 80, protocol: 'TCP' as const }])}
              style={{ fontSize: 10, fontWeight: 600, color: '#475569', background: '#f1f5f9', border: '1px dashed #cbd5e1', borderRadius: 5, cursor: 'pointer', padding: '4px 10px', marginBottom: 4 }}>
              + Adicionar porta
            </button>
            <div style={{ fontSize: 10, color: '#f59e0b', marginTop: 2 }}>
              A policy será recriada ao salvar.
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={handleSave}
              disabled={saving || !ports.every(p => !p.endPort || p.endPort >= p.port)}
              style={{ flex: 1, background: saving ? '#93c5fd' : '#2563eb', color: 'white', border: 'none', borderRadius: 7, padding: '9px', fontSize: 12, fontWeight: 600, cursor: saving ? 'not-allowed' : 'pointer' }}
            >
              {saving ? 'Salvando…' : 'Salvar'}
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting}
              style={{ flex: 1, background: deleting ? '#fca5a5' : '#fee2e2', color: '#dc2626', border: 'none', borderRadius: 7, padding: '9px', fontSize: 12, fontWeight: 600, cursor: deleting ? 'not-allowed' : 'pointer' }}
            >
              {deleting ? 'Removendo…' : 'Remover policy'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Main component ────────────────────────────────────────────────────────
interface Props {
  services: ServiceInfo[]
  policies: NetworkPolicyInfo[]
  allPolicies?: NetworkPolicyInfo[]
  drafts: Draft[]
  pendingApprovals: ApprovalRequest[]
  serviceLayouts: ServiceLayout[]
  namespaceLocks: Record<string, boolean>
  layoutSaveStatus?: 'idle' | 'saving' | 'draft' | 'saved' | 'error'
  autosave?: boolean
  onToggleAutosave?: () => void
  nsPositionsFromDB: Record<string, { x: number; y: number }>
  layoutResetKey: number
  globalLocked: boolean
  isViewer?: boolean
  isAdmin?: boolean
  canManageNamespace?: (namespace: string) => boolean
  onServiceMove: (req: { namespace: string; service_name: string; x: number; y: number }) => Promise<void>
  onNsMove: (ns: string, pos: { x: number; y: number }) => Promise<void>
  onAutoLayoutServices: (
    items: Array<{ namespace: string; service_name: string; x: number; y: number }>,
    namespaces?: Array<{ namespace: string; x: number; y: number }>
  ) => Promise<void>
  onToggleNamespaceLock: (namespace: string, locked: boolean) => Promise<void>
  onSaveLayout?: () => void
  onDiscardLayout?: () => void
  onAddDraft: (d: Omit<Draft, 'id'>) => void
  onRemoveDraft: (id: string) => void
  onPolicyChanged: () => void
  ciliumFlows?: CiliumFlowSummary[]
  ciliumStreaming?: boolean
  ignoredNamespaces?: string[]
  visibleNamespaces?: Set<string>
}

// ─── Layout toolbar ────────────────────────────────────────────────────────
function LayoutToolbar({
  layoutSaveStatus, autosave, isAdmin,
  onSaveLayout, onDiscardLayout, onToggleAutosave,
  onAutoLayout,
}: {
  layoutSaveStatus: 'idle' | 'saving' | 'draft' | 'saved' | 'error'
  autosave: boolean
  isAdmin: boolean
  onSaveLayout?: () => void
  onDiscardLayout?: () => void
  onToggleAutosave?: () => void
  onAutoLayout: (mode: 'namespaces' | 'services' | 'both') => void
}) {
  // getNodesBounds from the hook (not the top-level export) is needed here:
  // service nodes are positioned relative to their namespace parent node, and
  // only the hook version resolves that via the internal nodeLookup to give
  // correct absolute bounds.
  const { fitView, getNodes, getNodesBounds } = useReactFlow()
  const [layoutMode, setLayoutMode] = React.useState<'namespaces' | 'services' | 'both'>('both')
  const [tick, setTick] = React.useState(0)
  const [capturing, setCapturing] = React.useState(false)

  const handleScreenshot = useCallback(async () => {
    const nodes = getNodes()
    if (nodes.length === 0 || capturing) return
    setCapturing(true)
    try {
      const viewportEl = document.querySelector<HTMLElement>('.react-flow__viewport')
      if (!viewportEl) return
      const bounds = getNodesBounds(nodes)
      const SCALE = 2 // high-resolution multiplier
      const imageWidth  = Math.max(1, Math.round(bounds.width  * SCALE))
      const imageHeight = Math.max(1, Math.round(bounds.height * SCALE))
      const viewport = getViewportForBounds(bounds, imageWidth, imageHeight, 0.1, 4, 0.08)
      const dataUrl = await toPng(viewportEl, {
        backgroundColor: '#f8fafc',
        width: imageWidth,
        height: imageHeight,
        style: {
          width: `${imageWidth}px`,
          height: `${imageHeight}px`,
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`,
        },
      })
      const a = document.createElement('a')
      a.href = dataUrl
      a.download = `floodgate-grafo-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`
      a.click()
    } catch {
      // captura falhou silenciosamente (ex: imagem grande demais) — usuário pode tentar de novo
    } finally {
      setCapturing(false)
    }
  }, [getNodes, getNodesBounds, capturing])
  useEffect(() => {
    if (layoutSaveStatus !== 'saving') return
    const id = setInterval(() => setTick(t => t + 1), 120)
    return () => clearInterval(id)
  }, [layoutSaveStatus])

  const saving  = layoutSaveStatus === 'saving'
  const hasDraft = layoutSaveStatus === 'draft'
  const dirty   = saving || hasDraft
  const saved   = layoutSaveStatus === 'saved'
  const errored = layoutSaveStatus === 'error'
  const frames  = ['⠋', '⠙', '⠸', '⠴', '⠦', '⠇']
  const isSavingLocal = saving && !autosave

  const divStyle: React.CSSProperties = {
    width: 1, alignSelf: 'stretch', background: '#f1f5f9', margin: '0 2px', flexShrink: 0,
  }
  const segStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px',
  }
  const actionBtnStyle = (color: string, bg: string, hoverBg: string): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', gap: 4,
    height: 26, padding: '0 9px', borderRadius: 6,
    border: `1px solid ${bg === 'transparent' ? color + '44' : bg}`,
    background: 'transparent', cursor: 'pointer', color,
    fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
    transition: 'background 0.12s',
  })

  return (
    <div style={{
      display: 'flex', alignItems: 'center', height: 36,
      background: 'white', borderRadius: 10,
      border: '1px solid #e2e8f0',
      boxShadow: '0 2px 10px rgba(0,0,0,0.08)',
      overflow: 'hidden', userSelect: 'none',
    }}>

      {/* ── Status + actions ── */}
      {(dirty || saved || errored) && (
        <>
          <div style={{ ...segStyle }}>
            {/* Status dot */}
            <div style={{
              width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
              background: hasDraft ? '#8b5cf6' : isSavingLocal ? '#8b5cf6' : saving ? '#f59e0b' : saved ? '#22c55e' : '#ef4444',
              boxShadow: `0 0 0 2px ${(hasDraft || isSavingLocal) ? '#ede9fe' : saving ? '#fef3c7' : saved ? '#dcfce7' : '#fee2e2'}`,
            }} />
            <span style={{
              fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
              color: hasDraft ? '#6d28d9' : isSavingLocal ? '#6d28d9' : saving ? '#92400e' : saved ? '#15803d' : '#dc2626',
            }}>
              {hasDraft
                ? 'Rascunho local'
                : isSavingLocal
                  ? `${frames[tick % frames.length]} Salvando local`
                  : saving
                    ? `${frames[tick % frames.length]} Salvando`
                    : saved ? 'Salvo' : 'Erro ao salvar'}
            </span>

            {/* Salvar: admin only, quando tem rascunho ou está salvando local */}
            {(hasDraft || isSavingLocal) && isAdmin && (
              <button
                onClick={onSaveLayout}
                style={actionBtnStyle('#2563eb', '#eff6ff', '#dbeafe')}
                onMouseEnter={e => (e.currentTarget.style.background = '#dbeafe')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
                Salvar
              </button>
            )}
            {/* Descartar: todos os usuários */}
            {dirty && (
              <button
                onClick={onDiscardLayout}
                style={actionBtnStyle('#dc2626', '#fef2f2', '#fee2e2')}
                onMouseEnter={e => (e.currentTarget.style.background = '#fee2e2')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-3.49"/></svg>
                Descartar
              </button>
            )}
          </div>
          <div style={divStyle} />
        </>
      )}

      {/* ── Auto-save toggle: admin only ── */}
      {isAdmin && (
        <>
          <button
            onClick={onToggleAutosave}
            title={autosave ? 'Auto-save ativo: clique para desativar' : 'Auto-save desativado: clique para ativar'}
            style={{ ...segStyle, height: '100%', background: 'none', border: 'none', cursor: 'pointer', gap: 7 }}
            onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            {/* Toggle switch */}
            <div style={{
              width: 30, height: 17, borderRadius: 8.5, flexShrink: 0,
              background: autosave ? '#16a34a' : '#d1d5db',
              position: 'relative', transition: 'background 0.2s',
            }}>
              <div style={{
                position: 'absolute', width: 13, height: 13, borderRadius: '50%',
                background: 'white', top: 2, left: autosave ? 15 : 2,
                transition: 'left 0.2s',
                boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
              }} />
            </div>
            <span style={{ fontSize: 11, fontWeight: 600, color: autosave ? '#15803d' : '#9ca3af', whiteSpace: 'nowrap' }}>
              Auto-save
            </span>
          </button>
          <div style={divStyle} />
        </>
      )}

      {/* ── Auto-organizar ── */}
      <div style={{ ...segStyle, gap: 0 }}>
        <select
          value={layoutMode}
          onChange={e => setLayoutMode(e.target.value as typeof layoutMode)}
          style={{
            border: 'none', background: 'transparent', fontSize: 11, fontWeight: 600,
            color: '#475569', cursor: 'pointer', padding: '0 4px 0 8px', height: 36,
            outline: 'none', appearance: 'none',
          }}
        >
          <option value="namespaces">Namespaces</option>
          <option value="services">Serviços</option>
          <option value="both">Ambos</option>
        </select>
        <button
          onClick={() => { onAutoLayout(layoutMode); setTimeout(() => fitView({ padding: 0.15, duration: 400 }), 50) }}
          title="Auto-organizar layout"
          style={{
            height: 36, padding: '0 10px', border: 'none', background: 'none',
            fontSize: 11, fontWeight: 600, color: '#475569', cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 5, transition: 'background 0.12s',
          }}
          onMouseEnter={e => (e.currentTarget.style.background = '#f1f5f9')}
          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
            <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
          </svg>
          Organizar
        </button>
      </div>
      <div style={divStyle} />

      {/* ── Screenshot ── */}
      <button
        onClick={handleScreenshot}
        disabled={capturing}
        title="Baixar screenshot do grafo inteiro em alta resolução"
        style={{
          height: 36, padding: '0 10px', border: 'none', background: 'none',
          fontSize: 11, fontWeight: 600, color: capturing ? '#94a3b8' : '#475569',
          cursor: capturing ? 'default' : 'pointer',
          display: 'flex', alignItems: 'center', gap: 5, transition: 'background 0.12s',
        }}
        onMouseEnter={e => { if (!capturing) e.currentTarget.style.background = '#f1f5f9' }}
        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
          <circle cx="12" cy="13" r="4"/>
        </svg>
        {capturing ? 'Capturando…' : 'Screenshot'}
      </button>
    </div>
  )
}

export default function NetworkGraph({
  services, policies, allPolicies, drafts, pendingApprovals, serviceLayouts, namespaceLocks,
  nsPositionsFromDB, layoutResetKey, globalLocked,
  isViewer, isAdmin, canManageNamespace, onServiceMove, onNsMove,
  onAutoLayoutServices, onToggleNamespaceLock,
  autosave = true, onToggleAutosave,
  onSaveLayout, onDiscardLayout,
  onAddDraft, onRemoveDraft, onPolicyChanged,
  layoutSaveStatus = 'idle',
  ciliumFlows, ciliumStreaming, ignoredNamespaces = [], visibleNamespaces,
}: Props) {
  const [nodes, setNodes] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<BuiltInEdge>([])
  const [selectedNodeId, setSelectedNodeId] = React.useState<string | null>(null)
  const [selectedNs, setSelectedNs]         = React.useState<string | null>(null)
  const [editingPolicy, setEditingPolicy]   = React.useState<NetworkPolicyInfo | null>(null)
  const [selectedFlowEdge, setSelectedFlowEdge] = React.useState<Edge | null>(null)
  const [showFlowEdges, setShowFlowEdges]   = React.useState(true)

  const nsPositions  = useRef<Map<string, { x: number; y: number }>>(new Map())
  const nsPaletteIdx = useRef<Map<string, number>>(new Map())
  const dragStartPos = useRef<Map<string, { x: number; y: number }>>(new Map())
  const rebuildRef = useRef<(mode?: 'namespaces' | 'services' | 'both', force?: boolean, persist?: boolean) => Promise<void>>(() => Promise.resolve())

  const rebuildGraph = useCallback(async (layoutMode: 'namespaces' | 'services' | 'both' = 'both', forceNsReset = false, persistAutoLayout = false) => {
    // When the user explicitly triggers auto-layout for namespaces, clear saved positions first
    if (forceNsReset && (layoutMode === 'namespaces' || layoutMode === 'both')) {
      nsPositions.current.clear()
    }
    const { nodes: n, edges: e } = buildGraph(
      services, policies, drafts, pendingApprovals, serviceLayouts, namespaceLocks, onToggleNamespaceLock,
      nsPositions.current, nsPaletteIdx.current, canManageNamespace,
      layoutMode, globalLocked,
      ciliumFlows ?? [], showFlowEdges, ignoredNamespaces, visibleNamespaces,
    )
    setNodes(n)
    setEdges(e)
    if (!persistAutoLayout) return

    if (layoutMode === 'services' || layoutMode === 'both') {
      const movedServices = n
        .filter(node => node.id.startsWith('svc::'))
        .map(node => {
          const [, namespace, service_name] = node.id.split('::')
          return { namespace, service_name, x: node.position.x, y: node.position.y }
        })
      const movedNamespaces = layoutMode === 'both'
        ? n
            .filter(node => node.id.startsWith('ns::'))
            .map(node => ({ namespace: node.id.slice(4), x: node.position.x, y: node.position.y }))
        : []
      await onAutoLayoutServices(movedServices, movedNamespaces)
    } else if (layoutMode === 'namespaces') {
      const movedNamespaces = n
        .filter(node => node.id.startsWith('ns::'))
        .map(node => ({ namespace: node.id.slice(4), x: node.position.x, y: node.position.y }))
      await onAutoLayoutServices([], movedNamespaces)
    }
  }, [services, policies, drafts, pendingApprovals, serviceLayouts, namespaceLocks, canManageNamespace, onToggleNamespaceLock, onAutoLayoutServices, globalLocked, ciliumFlows, showFlowEdges, ignoredNamespaces, visibleNamespaces])

  useEffect(() => { rebuildRef.current = rebuildGraph }, [rebuildGraph])
  useEffect(() => { rebuildGraph('namespaces').catch(() => {}) }, [rebuildGraph])

  // Apply DB positions whenever they arrive (initial load or poll)
  useEffect(() => {
    if (Object.keys(nsPositionsFromDB).length === 0) return
    for (const [ns, pos] of Object.entries(nsPositionsFromDB)) {
      nsPositions.current.set(ns, pos)
    }
    rebuildRef.current('namespaces', false, false).catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nsPositionsFromDB])

  // Re-initialize from DB when user discards layout changes
  useEffect(() => {
    if (layoutResetKey === 0) return
    nsPositions.current.clear()
    for (const [ns, pos] of Object.entries(nsPositionsFromDB)) nsPositions.current.set(ns, pos)
    rebuildRef.current('namespaces', false, false).catch(() => {})
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutResetKey])

  const handleNodesChange = useCallback((changes: NodeChange[]) => {
    setNodes(nds => {
      const adjusted = changes.map(change => {
        if (change.type !== 'position' || !change.id.startsWith('svc::') || !change.position) return change
        const node = nds.find(n => n.id === change.id)
        const parent = node ? nds.find(n => n.id === node.parentId) : undefined
        if (!node || !parent) return change

        const parentW = Number(parent.style?.width ?? 0)
        const parentH = Number(parent.style?.height ?? 0)
        const minX = 2
        const maxX = Math.max(minX, parentW - NODE_W - 2)
        const minY = NS_HEADER + 4
        const maxY = Math.max(minY, parentH - NODE_H - 2)

        return {
          ...change,
          position: {
            x: Math.min(maxX, Math.max(minX, change.position.x)),
            y: Math.min(maxY, Math.max(minY, change.position.y)),
          },
        }
      })

      return applyNodeChanges(adjusted, nds)
    })
  }, [])

  const handleNodeDragStart = useCallback((_: React.MouseEvent, node: Node) => {
    dragStartPos.current.set(node.id, { x: node.position.x, y: node.position.y })
  }, [])

  const handleNodeDragStop = useCallback((_: React.MouseEvent, node: Node) => {
    const start = dragStartPos.current.get(node.id)
    if (!start) return

    if (node.id.startsWith('ns::')) {
      const candidate = {
        x: node.position.x,
        y: node.position.y,
        w: Number(node.style?.width ?? 0),
        h: Number(node.style?.height ?? 0),
      }
      const collides = nodes
        .filter(n => n.id.startsWith('ns::') && n.id !== node.id)
        .some(other => rectsOverlap(
          candidate,
          { x: other.position.x, y: other.position.y, w: Number(other.style?.width ?? 0), h: Number(other.style?.height ?? 0) },
          8
        ))

      if (collides) {
        setNodes(nds => nds.map(n => n.id === node.id ? { ...n, position: start } : n))
      } else {
        nsPositions.current.set(node.id.slice(4), node.position)
        onNsMove(node.id.slice(4), node.position).catch(() => {})
      }
      return
    }

    if (node.id.startsWith('svc::')) {
      const parent = nodes.find(n => n.id === node.parentId)
      if (!parent) return
      const parentW = Number(parent.style?.width ?? 0)
      const parentH = Number(parent.style?.height ?? 0)
      const minX = 2
      const maxX = Math.max(minX, parentW - NODE_W - 2)
      const minY = NS_HEADER + 4
      const maxY = Math.max(minY, parentH - NODE_H - 2)
      const clamped = {
        x: Math.min(maxX, Math.max(minX, node.position.x)),
        y: Math.min(maxY, Math.max(minY, node.position.y)),
      }

      const candidate = { x: clamped.x, y: clamped.y, w: NODE_W, h: NODE_H }
      const collides = nodes
        .filter(n => n.id.startsWith('svc::') && n.parentId === node.parentId && n.id !== node.id)
        .some(other => rectsOverlap(candidate, { x: other.position.x, y: other.position.y, w: NODE_W, h: NODE_H }, 4))

      if (collides) {
        setNodes(nds => nds.map(n => n.id === node.id ? { ...n, position: start } : n))
        return
      }

      setNodes(nds => nds.map(n => n.id === node.id ? { ...n, position: clamped } : n))
      const [, ns, svc] = node.id.split('::')
      if (ns && svc) {
        onServiceMove({ namespace: ns, service_name: svc, x: clamped.x, y: clamped.y }).catch(() => {})
      }
    }
  }, [nodes, onServiceMove, onNsMove, setNodes])

  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    if (node.id.startsWith('svc::')) { setSelectedNs(null); setSelectedNodeId(node.id) }
    if (node.id.startsWith('ns::')) { setSelectedNodeId(null); setSelectedNs(node.id.slice(4)) }
  }, [])

  const onConnect = useCallback((connection: Connection) => {
    if (isViewer) return
    const src = connection.source?.split('::')
    const dst = connection.target?.split('::')
    if (!src || !dst || src.length < 3 || dst.length < 3) return
    if (typeof canManageNamespace === 'function' && !canManageNamespace(dst[1])) return
    const dstSvc = services.find(s => s.name === dst[2] && s.namespace === dst[1])
    const dstPort = dstSvc?.ports[0]?.port ?? 80
    onAddDraft({ src_workload: src[2], src_namespace: src[1], dst_service: dst[2], dst_namespace: dst[1], dst_ports: [{ port: dstPort, protocol: 'TCP' }], policy_direction: 'both' })
  }, [onAddDraft, services, isViewer, canManageNamespace])

  function handleEdgeClick(_: React.MouseEvent, edge: Edge) {
    if (edge.data?.type === 'flow') {
      const flow = edge.data.flow as CiliumFlowSummary
      if (flow.verdict === 'DROPPED') setSelectedFlowEdge(edge)
      return
    }
    if (isViewer) return
    if (edge.data?.type === 'draft') {
      onRemoveDraft((edge.data.draft as Draft).id)
    }
    if (edge.data?.type === 'policy') {
      const policy = edge.data.policy as NetworkPolicyInfo
      if (typeof canManageNamespace === 'function' && !canManageNamespace(policy.namespace)) return
      setEditingPolicy(policy)
    }
  }

  return (
    <div style={{ flex: 1, height: '100%', position: 'relative' }}>
      <ReactFlow
        nodes={nodes} edges={edges}
        onNodesChange={handleNodesChange}
        onNodeDragStart={handleNodeDragStart}
        onNodeDragStop={handleNodeDragStop}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onEdgeClick={handleEdgeClick}
        onNodeClick={handleNodeClick}
        onPaneClick={() => { setSelectedNodeId(null); setSelectedNs(null); setSelectedFlowEdge(null) }}
        nodeTypes={nodeTypes}
        fitView fitViewOptions={{ padding: 0.15 }}
        minZoom={0.08} maxZoom={2}
        panOnScroll={true}
        panOnDrag={[1, 2]}
        zoomOnScroll={false}
        zoomOnPinch={true}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} color="#e2e8f0" />
        <Controls position="bottom-left" />
        <MiniMap position="bottom-right" zoomable pannable style={{ width: 160, height: 100 }} />
        <Panel position="top-right">
          <LayoutToolbar
            layoutSaveStatus={layoutSaveStatus}
            autosave={autosave}
            isAdmin={!!isAdmin}
            onSaveLayout={onSaveLayout}
            onDiscardLayout={onDiscardLayout}
            onToggleAutosave={onToggleAutosave}
            onAutoLayout={(mode) => rebuildGraph(mode, true, true)}
          />
        </Panel>
        {(ciliumStreaming || (ciliumFlows && ciliumFlows.length > 0)) && (
          <Panel position="top-left">
            <button
              onClick={() => setShowFlowEdges(v => !v)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '5px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                cursor: 'pointer',
                background: showFlowEdges ? '#eff6ff' : '#f8fafc',
                border: `1px solid ${showFlowEdges ? '#93c5fd' : '#cbd5e1'}`,
                color: showFlowEdges ? '#1d4ed8' : '#64748b',
              }}
            >
              <span style={{
                width: 7, height: 7, borderRadius: '50%',
                background: ciliumStreaming ? '#22c55e' : '#94a3b8',
                flexShrink: 0,
              }} />
              Tráfego ao vivo
            </button>
          </Panel>
        )}
      </ReactFlow>

      {editingPolicy && (
        <EditPolicyModal
          policy={editingPolicy}
          onClose={() => setEditingPolicy(null)}
          onSaved={() => { setEditingPolicy(null); onPolicyChanged() }}
          onDeleted={() => { setEditingPolicy(null); onPolicyChanged() }}
        />
      )}

      {selectedNodeId && selectedNodeId.startsWith('svc::') && (
        <ServiceDetailPanel
          nodeId={selectedNodeId}
          services={services}
          policies={policies}
          drafts={drafts}
          isViewer={isViewer}
          canManageNamespace={canManageNamespace}
          onClose={() => setSelectedNodeId(null)}
          onPolicyChanged={onPolicyChanged}
        />
      )}

      {selectedNs && (
        <NamespaceDetailPanel
          namespace={selectedNs}
          services={services}
          policies={policies}
          isViewer={isViewer}
          canManageNamespace={canManageNamespace}
          onClose={() => setSelectedNs(null)}
          onPolicyChanged={onPolicyChanged}
        />
      )}

      {selectedFlowEdge && (
        <FlowExplainPanel
          edge={selectedFlowEdge}
          policies={allPolicies ?? policies}
          onClose={() => setSelectedFlowEdge(null)}
        />
      )}

      <div style={{
        position: 'absolute', bottom: 12, left: '50%', transform: 'translateX(-50%)',
        background: 'rgba(15,23,42,0.7)', color: 'white', borderRadius: 20,
        padding: '4px 14px', fontSize: 10, display: 'flex', gap: 14, pointerEvents: 'none',
        backdropFilter: 'blur(4px)',
      }}>
        <span>🖱 arrastar namespace</span>
        <span>⚙ scroll = navegar</span>
        <span>↗ arrastar handle azul = conectar</span>
      </div>
    </div>
  )
}
