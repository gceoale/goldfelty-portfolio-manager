import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { HistoryRange, PortfolioSnapshot } from '@shared/types.ts'
import { compactMoney, dateTime, money, shortDate } from '../lib/format.ts'

const PAD = { top: 10, right: 64, bottom: 26, left: 0 }

/** Round tick values: 1, 2, 2.5 or 5 times a power of ten. */
function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return []
  if (min === max) {
    const pad = Math.abs(min) * 0.05 || 1
    min -= pad
    max += pad
  }
  const raw = (max - min) / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw
  const ticks: number[] = []
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) ticks.push(Number(v.toFixed(10)))
  return ticks
}

/**
 * Portfolio value over time. One series, so no legend: the page title names
 * it. Value axis on the right, dates below, a crosshair and readout on hover.
 */
export function ValueChart({
  data,
  currency,
  range,
  height = 220,
  hidden = false
}: {
  data: PortfolioSnapshot[]
  currency: string
  range: HistoryRange
  height?: number
  hidden?: boolean
}): JSX.Element {
  const wrap = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(640)
  const [hover, setHover] = useState<number | null>(null)

  useEffect(() => {
    const node = wrap.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width)
      if (w > 0) setWidth(w)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  const geo = useMemo(() => {
    if (data.length < 2) return null
    const values = data.map((p) => p.total)
    const ticks = niceTicks(Math.min(...values), Math.max(...values))
    const lo = ticks[0]
    const hi = ticks[ticks.length - 1]
    const t0 = data[0].at
    const t1 = data[data.length - 1].at
    const innerW = Math.max(10, width - PAD.left - PAD.right)
    const innerH = height - PAD.top - PAD.bottom
    const x = (at: number): number => PAD.left + (t1 === t0 ? innerW / 2 : ((at - t0) / (t1 - t0)) * innerW)
    const y = (v: number): number => PAD.top + innerH - ((v - lo) / (hi - lo || 1)) * innerH
    const points = data.map((p) => ({ x: x(p.at), y: y(p.total), p }))
    const line = points.map((pt, i) => `${i ? 'L' : 'M'}${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`).join(' ')
    const area = `${line} L${points[points.length - 1].x.toFixed(1)} ${PAD.top + innerH} L${points[0].x.toFixed(1)} ${PAD.top + innerH} Z`
    const dateTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => ({ at: t0 + (t1 - t0) * f, x: PAD.left + innerW * f }))
    return { ticks, y, points, line, area, dateTicks, innerW, innerH }
  }, [data, width, height])

  if (!geo) {
    return (
      <div className="chart chart-empty" ref={wrap} style={{ height }}>
        <span>Not enough history yet. Goldfelty records a point each time it refreshes.</span>
      </div>
    )
  }

  const onMove = (e: React.PointerEvent<SVGSVGElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = e.clientX - rect.left
    let best = 0
    for (let i = 1; i < geo.points.length; i++) {
      if (Math.abs(geo.points[i].x - px) < Math.abs(geo.points[best].x - px)) best = i
    }
    setHover(best)
  }

  const h = hover === null ? null : geo.points[hover]
  const first = data[0].total
  const last = data[data.length - 1].total

  return (
    <div className="chart" ref={wrap}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={`Portfolio value from ${money(first, currency)} to ${money(last, currency)} over the selected period`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {geo.ticks.map((t) => (
          <g key={t}>
            <line className="chart-grid" x1={PAD.left} x2={PAD.left + geo.innerW} y1={geo.y(t)} y2={geo.y(t)} />
            <text className="chart-axis" x={PAD.left + geo.innerW + 8} y={geo.y(t)} dy="0.32em">
              {hidden ? '•••' : compactMoney(t, currency)}
            </text>
          </g>
        ))}
        {geo.dateTicks.map((d, i) => (
          <text
            key={i}
            className="chart-axis"
            x={d.x}
            y={PAD.top + geo.innerH + 18}
            textAnchor={i === 0 ? 'start' : i === geo.dateTicks.length - 1 ? 'end' : 'middle'}
          >
            {shortDate(d.at, range)}
          </text>
        ))}
        <path className="chart-area" d={geo.area} />
        <path className="chart-line" d={geo.line} />
        {h ? (
          <g>
            <line className="chart-cross" x1={h.x} x2={h.x} y1={PAD.top} y2={PAD.top + geo.innerH} />
            <circle className="chart-point" cx={h.x} cy={h.y} r={4} />
          </g>
        ) : null}
      </svg>
      {h ? (
        <div className="chart-tip" style={{ left: Math.min(Math.max(h.x, 70), width - PAD.right - 70), top: 0 }}>
          <strong>{hidden ? '•••••' : money(h.p.total, currency)}</strong>
          <span>{dateTime(h.p.at)}</span>
        </div>
      ) : null}
    </div>
  )
}
