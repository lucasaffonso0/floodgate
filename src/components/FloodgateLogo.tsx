'use client'
import { useEffect, useRef } from 'react'

// ─── Animation constants ───────────────────────────────────────────────────
const CYCLE = 7000

const X_START = 50
const X_END   = 168
const X_STOP  = 130

// Timeline (fraction of CYCLE):
//  0.00–0.32  OPEN   → packets traverse
//  0.32–0.36  CLOSING (gap)
//  0.36–0.92  CLOSED → packets hit bar and bounce back
//  0.92–0.96  OPENING (gap)
//  0.96–1.00  OPEN   → packets traverse
const OPEN1_END  = 0.32
const CLOSED_BEG = 0.36
const CLOSED_END = 0.92
const OPEN2_BEG  = 0.99

const LINE_OFFSETS  = [0.00, 0.33, 0.66]
const LINE_BASE_OPS = [1.00, 0.75, 0.50]

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * Math.max(0, Math.min(1, t))
}
function eio(t: number) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
}

function barY(t: number): number {
  let state: number
  if (t < OPEN1_END)       state = 0
  else if (t < CLOSED_BEG) state = eio((t - OPEN1_END) / (CLOSED_BEG - OPEN1_END))
  else if (t < CLOSED_END) state = 1
  else if (t < OPEN2_BEG)  state = 1 - eio((t - CLOSED_END) / (OPEN2_BEG - CLOSED_END))
  else                      state = 0
  return lerp(-90, 0, state)
}

function packetOpen(t: number, winStart: number, winEnd: number, offset: number): { x: number; op: number } | null {
  const dur = 0.15
  if (winEnd - winStart < dur) return null

  const phaseT = (t - winStart + offset * dur) / dur
  const localCycle = phaseT % 1
  const cycleIdx = Math.floor(phaseT)
  const cycleStart = winStart + (cycleIdx - offset) * dur
  if (cycleStart < winStart || cycleStart + dur > winEnd) return null

  const k = eio(localCycle)
  const x = lerp(X_START, X_END, k)
  let op = 1
  if (localCycle < 0.10) op = localCycle / 0.10
  else if (localCycle > 0.90) op = 1 - (localCycle - 0.90) / 0.10
  return { x, op }
}

function packetBlock(t: number, winStart: number, winEnd: number, offset: number): { x: number; op: number } | null {
  const dur = 0.22
  const interval = dur * 0.8
  if (t < winStart || t > winEnd - dur * 0.5) return null

  const localCycle = ((t - winStart) + offset * interval) % interval
  if (localCycle >= dur) return null

  const local = localCycle / dur
  let x: number, op: number
  if (local < 0.45) {
    const k = eio(local / 0.45)
    x = lerp(X_START, X_STOP, k)
    op = local < 0.08 ? local / 0.08 : 1
  } else if (local < 0.55) {
    x = X_STOP
    op = 1
  } else if (local < 0.85) {
    const k = eio((local - 0.55) / 0.30)
    x = lerp(X_STOP, X_STOP - 10, k)
    op = 1 - k
  } else {
    return null
  }
  return { x, op }
}

function useGateAnimation(
  barRef: React.RefObject<SVGRectElement | null>,
  lineRefs: React.RefObject<SVGLineElement | null>[],
  tracks: number[],
) {
  useEffect(() => {
    let raf: number
    let start: number | null = null

    function tick(ts: number) {
      if (!start) start = ts
      const elapsed = (ts - start) / CYCLE
      const t = elapsed % 0.6

      const bar = barRef.current
      if (bar) {
        bar.setAttribute('transform', `translate(0, ${barY(t)})`)

        lineRefs.forEach((ref, i) => {
          const line = ref.current
          if (!line) return

          const y = tracks[i]
          const offset = LINE_OFFSETS[i]
          const baseOp = LINE_BASE_OPS[i]

          let result: { x: number; op: number } | null = null
          if (t < OPEN1_END) {
            result = packetOpen(t, 0.00, OPEN1_END, offset)
          } else if (t >= CLOSED_BEG && t < OPEN2_BEG) {
            result = packetBlock(t, CLOSED_BEG, CLOSED_END, offset)
          } else if (t >= OPEN2_BEG) {
            result = packetOpen(t, OPEN2_BEG, 1.0, offset)
          }

          if (result) {
            line.setAttribute('x1', String(X_START))
            line.setAttribute('x2', String(result.x))
            line.setAttribute('y1', String(y))
            line.setAttribute('y2', String(y))
            line.style.opacity = String(result.op * baseOp)
          } else {
            line.style.opacity = '0'
          }
        })
      }

      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [barRef, lineRefs, tracks])
}

// ─── Shared SVG internals ──────────────────────────────────────────────────
function ShieldSVG({
  id,
  barRef,
  a1Ref,
  a2Ref,
  a3Ref,
}: {
  id: string
  barRef: React.RefObject<SVGRectElement | null>
  a1Ref: React.RefObject<SVGLineElement | null>
  a2Ref: React.RefObject<SVGLineElement | null>
  a3Ref: React.RefObject<SVGLineElement | null>
}) {
  return (
    <>
      <defs>
        <marker id={`${id}-m1`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M1 2L9 5L1 8" fill="none" stroke="#E6F1FB" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
        </marker>
        <marker id={`${id}-m2`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M1 2L9 5L1 8" fill="none" stroke="#B5D4F4" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
        </marker>
        <marker id={`${id}-m3`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M1 2L9 5L1 8" fill="none" stroke="#85B7EB" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
        </marker>
        <clipPath id={`${id}-sc`}>
          <path d="M110 24 L178 46 L178 120 Q178 168 110 188 Q42 168 42 120 L42 46 Z"/>
        </clipPath>
      </defs>

      <path d="M110 24 L178 46 L178 120 Q178 168 110 188 Q42 168 42 120 L42 46 Z" fill="#185FA5" stroke="#0C447C" strokeWidth="1"/>

      <line x1="50" y1="90"  x2="168" y2="90"  stroke="#B5D4F4" strokeWidth="0.8" opacity="0.15" strokeDasharray="4 3"/>
      <line x1="50" y1="112" x2="168" y2="112" stroke="#B5D4F4" strokeWidth="0.8" opacity="0.15" strokeDasharray="4 3"/>
      <line x1="50" y1="134" x2="168" y2="134" stroke="#B5D4F4" strokeWidth="0.8" opacity="0.15" strokeDasharray="4 3"/>

      <g clipPath={`url(#${id}-sc)`}>
        <line ref={a1Ref} x1="50" y1="90"  x2="50" y2="90"  stroke="#E6F1FB" strokeWidth="2.5" strokeLinecap="round" markerEnd={`url(#${id}-m1)`} opacity="0"/>
        <line ref={a2Ref} x1="50" y1="112" x2="50" y2="112" stroke="#B5D4F4" strokeWidth="2.5" strokeLinecap="round" markerEnd={`url(#${id}-m2)`} opacity="0"/>
        <line ref={a3Ref} x1="50" y1="134" x2="50" y2="134" stroke="#85B7EB" strokeWidth="2.5" strokeLinecap="round" markerEnd={`url(#${id}-m3)`} opacity="0"/>
      </g>

      <g clipPath={`url(#${id}-sc)`}>
        <rect ref={barRef} x="136" y="62" width="9" height="96" rx="4" fill="#E6F1FB"/>
      </g>
    </>
  )
}

// ─── Full logo (shield + wordmark + tagline) ───────────────────────────────
export function FloodgateLogoFull({ width = 240 }: { width?: number }) {
  const barRef = useRef<SVGRectElement>(null)
  const a1Ref  = useRef<SVGLineElement>(null)
  const a2Ref  = useRef<SVGLineElement>(null)
  const a3Ref  = useRef<SVGLineElement>(null)

  useGateAnimation(barRef, [a1Ref, a2Ref, a3Ref], [90, 112, 134])

  const vbW = 510, vbH = 174
  const height = Math.round(width * vbH / vbW)
  return (
    <svg width={width} height={height} viewBox={`42 18 ${vbW} ${vbH}`} role="img" xmlns="http://www.w3.org/2000/svg" style={{ display: 'block' }}>
      <title>Floodgate</title>
      <ShieldSVG id="full" barRef={barRef} a1Ref={a1Ref} a2Ref={a2Ref} a3Ref={a3Ref} />
      <text y="150" fontSize="68" fontFamily="Inter, -apple-system, sans-serif" fontWeight="500" letterSpacing="-1.5">
        <tspan x="208" fill="#042C53">flood</tspan><tspan fill="#185FA5">gate</tspan>
      </text>
      <text x="210" y="180" fontSize="15" fontFamily="Inter, -apple-system, sans-serif" fill="#888780" letterSpacing="3">NETWORKPOLICY MANAGER</text>
    </svg>
  )
}

// ─── Icon only ─────────────────────────────────────────────────────────────
export function FloodgateLogoIcon({ size = 28 }: { size?: number }) {
  const barRef = useRef<SVGRectElement>(null)
  const a1Ref  = useRef<SVGLineElement>(null)
  const a2Ref  = useRef<SVGLineElement>(null)
  const a3Ref  = useRef<SVGLineElement>(null)

  useGateAnimation(barRef, [a1Ref, a2Ref, a3Ref], [90, 112, 134])

  return (
    <svg width={size} height={size} viewBox="32 18 158 180" role="img" xmlns="http://www.w3.org/2000/svg" style={{ display: 'block', flexShrink: 0 }}>
      <title>Floodgate</title>
      <ShieldSVG id="icon" barRef={barRef} a1Ref={a1Ref} a2Ref={a2Ref} a3Ref={a3Ref} />
    </svg>
  )
}
