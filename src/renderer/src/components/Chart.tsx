import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { PortfolioSnapshot } from '@shared/types.js'
import { money } from '../lib/format.js'

interface Props {
  data: PortfolioSnapshot[]
  currency: string
  /** Positive periods draw green, negative red — the colour is the headline. */
  positive: boolean
  height?: number
}

const PAD = { top: 12, right: 4, bottom: 18, left: 4 }

/**
 * Portfolio value over time. Deliberately axis-light: the number that matters is
 * already in the hero, so the chart's job is shape, direction and a precise
 * read-out on hover.
 */
export function AreaChart({ data, currency, positive, height = 172 }: Props): JSX.Element {
  const ref = useRef<SVGSVGElement | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const [width, setWidth] = useState(720)

  // Track the real rendered width so the curve reflows with the window.
  useEffect(() => {
    const node = ref.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      const next = entry.contentRect.width
      if (next > 0) setWidth((current) => (Math.abs(current - next) > 1 ? next : current))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const measured = useMemo(() => {
    const points = data.length >= 2 ? data : []
    if (points.length === 0) return null

    const values = points.map((p) => p.total)
    const min = Math.min(...values)
    const max = Math.max(...values)
    // A flat line at the vertical centre beats a divide-by-zero.
    const span = max - min || Math.max(max, 1) * 0.08
    const lo = min - span * 0.12
    const hi = max + span * 0.12

    const innerW = width - PAD.left - PAD.right
    const innerH = height - PAD.top - PAD.bottom
    const x = (i: number): number => PAD.left + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW)
    const y = (v: number): number => PAD.top + innerH - ((v - lo) / (hi - lo)) * innerH

    const coords = points.map((p, i) => ({ x: x(i), y: y(p.total), snapshot: p }))

    // Catmull-Rom → cubic Bézier: a smooth line without the wild overshoot a
    // naive spline gives on spiky balance data.
    let line = `M ${coords[0].x.toFixed(2)} ${coords[0].y.toFixed(2)}`
    for (let i = 0; i < coords.length - 1; i++) {
      const p0 = coords[Math.max(0, i - 1)]
      const p1 = coords[i]
      const p2 = coords[i + 1]
      const p3 = coords[Math.min(coords.length - 1, i + 2)]
      const c1x = p1.x + (p2.x - p0.x) / 6
      const c1y = p1.y + (p2.y - p0.y) / 6
      const c2x = p2.x - (p3.x - p1.x) / 6
      const c2y = p2.y - (p3.y - p1.y) / 6
      line += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`
    }
    const area = `${line} L ${coords[coords.length - 1].x.toFixed(2)} ${height - PAD.bottom} L ${coords[0].x.toFixed(2)} ${height - PAD.bottom} Z`

    return { coords, line, area, lo, hi }
  }, [data, width, height])

  if (!measured) {
    return (
      <div
        style={{
          height,
          display: 'grid',
          placeItems: 'center',
          color: 'var(--text-muted)',
          fontSize: 12.5,
          border: '1px dashed var(--border-subtle)',
          borderRadius: 'var(--radius-md)'
        }}
      >
        Growth appears here once the app has a few balance readings to compare.
      </div>
    )
  }

  const stroke = positive ? 'var(--positive)' : 'var(--negative)'
  const gradientId = positive ? 'grad-pos' : 'grad-neg'
  const active = hover !== null ? measured.coords[hover] : null

  const onMove = (event: React.MouseEvent<SVGSVGElement>): void => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    if (rect.width !== width) setWidth(rect.width)
    const relative = event.clientX - rect.left
    let nearest = 0
    let best = Infinity
    measured.coords.forEach((coord, i) => {
      const distance = Math.abs(coord.x - relative)
      if (distance < best) {
        best = distance
        nearest = i
      }
    })
    setHover(nearest)
  }

  return (
    <div style={{ position: 'relative' }}>
      <svg
        ref={(node) => {
          ref.current = node
          const measuredWidth = node?.getBoundingClientRect().width
          if (measuredWidth && Math.abs(measuredWidth - width) > 1) setWidth(measuredWidth)
        }}
        width="100%"
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label="Portfolio value over time"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.26" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>

        {[0.25, 0.5, 0.75].map((fraction) => (
          <line
            key={fraction}
            x1={PAD.left}
            x2={width - PAD.right}
            y1={PAD.top + (height - PAD.top - PAD.bottom) * fraction}
            y2={PAD.top + (height - PAD.top - PAD.bottom) * fraction}
            stroke="var(--border-subtle)"
            strokeDasharray="3 5"
          />
        ))}

        <path d={measured.area} fill={`url(#${gradientId})`} />
        <path d={measured.line} fill="none" stroke={stroke} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

        {active && (
          <>
            <line x1={active.x} x2={active.x} y1={PAD.top} y2={height - PAD.bottom} stroke="var(--border-strong)" />
            <circle cx={active.x} cy={active.y} r={4.5} fill="var(--bg-surface)" stroke={stroke} strokeWidth={2} />
          </>
        )}
      </svg>

      {active && (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: Math.min(Math.max(active.x - 66, 0), Math.max(width - 132, 0)),
            width: 132,
            padding: '7px 9px',
            background: 'var(--bg-overlay)',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-sm)',
            boxShadow: 'var(--shadow-md)',
            pointerEvents: 'none',
            textAlign: 'center'
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 620, fontVariantNumeric: 'tabular-nums' }}>
            {money(active.snapshot.total, currency)}
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
            {new Date(active.snapshot.at).toLocaleString(undefined, {
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit'
            })}
          </div>
        </div>
      )}
    </div>
  )
}
