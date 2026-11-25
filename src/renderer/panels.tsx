import { useEffect, useRef, useState } from 'react'
import { Gamepad2, SquareTerminal } from 'lucide-react'
import logo from '../../assets/devshift.png'
import type { Dashboard, ReviewTarget, SwitchState, Workload } from '../shared/contracts.js'
import { bytes, clockTime, Empty, Icon, OutcomeBadge, percent, privateMemory } from './ui.js'

import { performanceGapMs, performanceWindowMs, powerModeName, type PerformanceSample } from '../shared/contracts.js'

export function ModeScene({ state }: { state: SwitchState }) {
  const gaming = state.mode === 'gaming'
  const interrupted = state.phase === 'RECOVERY_REQUIRED' || state.phase === 'FAILED'
  return (
    <section className={'mode-scene' + (gaming ? ' scene-gaming' : '')}>
      <div className="scene-grid" aria-hidden="true" />
      <div className="scene-text">
        <span className="scene-status"><i />{state.busy ? 'Switching environment' : interrupted ? 'Recovery required'
          : state.phase === 'PARTIAL_SUCCESS' ? 'Partial result' : 'Active environment'}</span>
        <h2>{gaming ? 'Gaming Mode' : 'Development Mode'}</h2>
        <p>{state.summary}</p>
      </div>
      <div className="scene-art" aria-hidden="true"><span /><span /><img src={logo} alt="" /></div>
    </section>
  )
}

export function Performance() {
  const [samples, setSamples] = useState<PerformanceSample[]>([])
  useEffect(() => window.devshift.onPerformance(setSamples), [])
  const current = samples.at(-1)
  const cpu = current?.cpu ?? null
  const used = current?.usedMemory ?? null
  const total = current?.totalMemory ?? null
  const utilization = used !== null && total !== null ? Math.round(100 * used / total) : null
  const cpuStatus = !current || (samples.length === 1 && total !== null) ? 'Sampling' : 'Unavailable'
  const cpuTrend = trend(samples, sample => sample.cpu)
  const memoryTrend = trend(samples, sample => sample.usedMemory !== null && sample.totalMemory
    ? 100 * sample.usedMemory / sample.totalMemory : null)
  return (
    <section className="telemetry" aria-label="System performance">
      <div className="pane-title"><h2>System performance</h2><span className="micro">1 s refresh · 60 s history</span></div>
      <div className="telemetry-grid">
        <div className="readout">
          <div className="readout-label"><span className="metric-dot cpu-dot" /><h3>CPU usage</h3></div>
          <div className="readout-value">{cpu === null ? '—' : Math.round(cpu) + '%'}<span>{cpu === null ? cpuStatus : 'System total'}</span></div>
          {cpu !== null && <span className="sr-only" role="meter" aria-label="CPU usage" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(cpu)} />}
          {cpuTrend && <p className="sr-only">{cpuTrend}</p>}
          <Trace values={samples} field="cpu" />
        </div>
        <div className="readout">
          <div className="readout-label"><span className="metric-dot memory-dot" /><h3>Memory used</h3></div>
          <div className="readout-value">{bytes(used, 'gb')}<span>{total === null ? (current ? 'Unavailable' : 'Sampling')
            : 'of ' + bytes(total, 'gb') + ' (' + utilization + '%)'}</span></div>
          {utilization !== null && <span className="sr-only" role="meter" aria-label="Memory used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={utilization} />}
          {memoryTrend && <p className="sr-only">{memoryTrend}</p>}
          <Trace values={samples} field="memory" />
        </div>
      </div>
    </section>
  )
}

// The charts are drawn on a canvas, so screen readers get the same minute as text instead.
function trend(samples: PerformanceSample[], read: (sample: PerformanceSample) => number | null) {
  const values = samples.map(read).filter((value): value is number => value !== null)
  if (values.length < 2) return null
  const average = Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
  return `Last minute: average ${average}%, peak ${Math.round(Math.max(...values))}%.`
}

function Trace({ values, field }: { values: PerformanceSample[]; field: 'cpu' | 'memory' }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const redraw = useRef<() => void>(() => {})
  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const target = values.at(-1)?.sampledAt ?? 0
    function draw() {
      if (!element) return
      const width = element.clientWidth
      const height = element.clientHeight
      if (!width || !height) return
      const scale = Math.min(devicePixelRatio || 1, 2)
      const pixelsWide = Math.floor(width * scale)
      const pixelsHigh = Math.floor(height * scale)
      if (element.width !== pixelsWide) element.width = pixelsWide
      if (element.height !== pixelsHigh) element.height = pixelsHigh
      const ctx = element.getContext('2d')
      if (!ctx) return
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
      ctx.clearRect(0, 0, width, height)
      const right = width - 5
      const bottom = height - 5
      const grid = (fromX: number, fromY: number, toX: number, toY: number) => {
        ctx.moveTo(fromX, fromY)
        ctx.lineTo(toX, toY)
      }
      ctx.strokeStyle = 'rgba(158, 168, 210, .12)'
      ctx.lineWidth = 1
      ctx.beginPath()
      for (let mark = 0; mark <= 8; mark++) {
        const x = Math.round(mark * right / 8) + 0.5
        grid(x, 2, x, bottom)
      }
      for (let mark = 0; mark <= 4; mark++) {
        const y = Math.round(mark * (bottom - 3) / 4) + 2.5
        grid(0, y, right, y)
      }
      ctx.stroke()

      type Point = { x: number; y: number }
      const segments: Point[][] = []
      let segment: Point[] = []
      let lastTime = 0
      for (const sample of values) {
        const value = field === 'cpu' ? sample.cpu : sample.usedMemory !== null && sample.totalMemory !== null
          ? sample.usedMemory / sample.totalMemory * 100 : null
        if (value === null || sample.sampledAt < target - performanceWindowMs) { segment = []; continue }
        if (sample.sampledAt - lastTime > performanceGapMs) segment = []
        if (segment.length === 0) segments.push(segment)
        segment.push({ x: right - (target - sample.sampledAt) / performanceWindowMs * right, y: bottom - value / 100 * (bottom - 4) })
        lastTime = sample.sampledAt
      }

      const cpu = field === 'cpu'
      const stroke = cpu ? '#b1a4fa' : '#70d6dd'
      const gradient = ctx.createLinearGradient(0, 0, 0, bottom + 8)
      gradient.addColorStop(0, cpu ? '#9b82ee74' : '#54c2d263')
      gradient.addColorStop(1, cpu ? '#8c6be617' : '#54c2d21a')
      ctx.fillStyle = gradient
      ctx.strokeStyle = stroke
      ctx.lineWidth = 1.6
      ctx.lineJoin = 'round'
      for (const points of segments) {
        const first = points[0]
        const last = points.at(-1)
        if (!first || !last) continue
        const line = new Path2D()
        line.moveTo(first.x, first.y)
        for (const point of points.slice(1)) line.lineTo(point.x, point.y)
        ctx.stroke(line)
        line.lineTo(last.x, bottom)
        line.lineTo(first.x, bottom)
        line.closePath()
        ctx.fill(line)
      }
      const latest = segment.at(-1)
      if (latest) {
        ctx.beginPath()
        ctx.arc(latest.x, latest.y, 2.4, 0, Math.PI * 2)
        ctx.fillStyle = stroke
        ctx.fill()
      }
    }
    redraw.current = draw
    draw()
  }, [values, field])
  useEffect(() => {
    if (!canvas.current) return
    const observer = new ResizeObserver(() => redraw.current())
    observer.observe(canvas.current)
    return () => observer.disconnect()
  }, [])
  return <canvas ref={canvas} className="trace" aria-hidden="true" />
}

export function SwitchControls({ data, state, disabled, review, preferences }: {
  data: Dashboard; state: SwitchState; disabled: boolean; review: (target: ReviewTarget) => void; preferences: () => void
}) {
  const active = data.power.plans.find(plan => plan.id === data.power.active)
  const preferred = data.power.plans.find(plan => plan.id === data.settings.gamingPlan)
  const mode = data.powerMode
  const gamingMode = data.settings.gamingPowerMode
  return (
    <>
      <section className="dock-section">
        <div className="dock-heading"><div className="dock-icon"><Icon type="switch" /></div><h2>Mode switch</h2></div>
        <div className="mode-switch" role="group" aria-label="Review a mode switch">
          <button aria-pressed={state.mode === 'development'} disabled={disabled || !state.hasSnapshot}
            onClick={() => review('development')}>
            <SquareTerminal size={20} aria-hidden="true" />Development
          </button>
          <button aria-pressed={state.mode === 'gaming'} disabled={disabled || state.hasSnapshot}
            onClick={() => review('gaming')}>
            <Gamepad2 size={20} aria-hidden="true" />Gaming
          </button>
        </div>
        <p className="dock-note">{state.hasSnapshot ? 'Review restoration to reopen captured workloads.' : 'Choose Gaming to review the changes first.'}</p>
      </section>
      <section className="dock-section power-section">
        <div className="dock-heading"><div className="dock-icon"><Icon type="power" /></div><h2>Power</h2></div>
        <strong className="power-name">{mode ? powerModeName(mode.pluggedIn ? mode.ac : mode.dc) : active?.name ?? 'Unavailable'}</strong>
        <dl className="power-settings">
          {mode && <div><dt>Gaming power mode</dt><dd>{gamingMode ? powerModeName(gamingMode) : 'Keep current'}</dd></div>}
          {mode && <div><dt>Power plan</dt><dd>{active?.name ?? 'Unavailable'}</dd></div>}
          <div><dt>Gaming power plan</dt><dd>{preferred?.name ?? (data.settings.gamingPlan ? 'Unavailable' : 'Keep current')}</dd></div>
        </dl>
        {mode?.energySaver && <p className="dock-note">Energy Saver is on, so Windows saves power until you plug in.</p>}
        <button className="text-button" onClick={preferences} disabled={disabled}>Power settings<Icon type="arrow" /></button>
      </section>
    </>
  )
}

export function RecentActions({ data, open }: { data: Dashboard; open: () => void }) {
  return <section className="dock-section dock-history">
    <div className="dock-heading"><div className="dock-icon"><Icon type="activity" /></div><h2>Recent activity</h2></div>
    {data.history.length ? <ol className="dock-events">
      {data.history.slice(0, 4).map(entry => <li key={entry.id}>
        <strong>{entry.title}</strong>
        <div><span>{clockTime(entry.time)}</span><OutcomeBadge status={entry.status} /></div>
      </li>)}
    </ol> : <p className="dock-note">No switches recorded yet.</p>}
    <button className="text-button" onClick={open}>Open activity<Icon type="arrow" /></button>
  </section>
}

export function WorkloadInspector({ row, disabled, close, remove, revoke }: {
  row: Workload; disabled: boolean; close: () => void; remove: () => void; revoke: () => void
}) {
  return (
    <section className="dock-section workload-inspector" aria-label="Workload inspector">
      <div className="dock-heading"><div className="dock-icon"><Icon type="workloads" /></div><h2>Workload details</h2>
        <button className="icon-button dock-close" type="button" aria-label="Close workload details" onClick={close}><Icon type="close" /></button></div>
      <h3>{row.label}</h3>
      <p className="dock-note">{row.processRole ?? row.category}{row.kind === 'service' ? ' · Windows service' : ''}</p>
      <dl className="inspector-data">
        <div><dt>Status</dt><dd className={'row-state row-' + row.state}>{row.state === 'unknown' ? 'Unverified' : row.state}</dd></div>
        <div><dt>Process ID</dt><dd>{row.pid ?? 'Unavailable'}</dd></div>
        <div><dt>Parent process ID</dt><dd>{row.parentPid ?? 'Unavailable'}</dd></div>
        <div><dt>Private working set</dt><dd>{privateMemory(row.privateMemoryBytes)}</dd></div>
        <div><dt>Total working set</dt><dd>{bytes(row.memoryBytes)}</dd></div>
        <div><dt>CPU</dt><dd>{percent(row.cpu)}</dd></div>
        <div className="inspector-span"><dt>Path</dt><dd className="path">{row.path ?? 'Unavailable to this account'}</dd></div>
        <div className="inspector-span"><dt>Restoration</dt><dd>{row.restoration}</dd></div>
      </dl>
      <p className="inspector-message">{row.detail}</p>
      {row.canRemove && <button className="button" onClick={remove} disabled={disabled}>Remove approval</button>}
      {row.kind === 'service' && row.approved && !row.canApprove &&
        <button className="button" onClick={revoke} disabled={disabled}>Remove approval</button>}
    </section>
  )
}

export function WorkloadStats({ data, runningCount }: { data: Dashboard; runningCount: number }) {
  const totals = [
    ['Running workloads', runningCount],
    ['Running processes', new Set(data.workloads.filter(row => row.state === 'running' && row.pid !== null).map(row => row.pid)).size],
    ['Approved', data.workloads.filter(row => row.approved).length],
    ['Installed tools', data.installed.length],
  ] as const
  return (
    <section className="dock-section">
      <div className="dock-heading"><div className="dock-icon"><Icon type="workloads" /></div><h2>Scan summary</h2></div>
      <dl className="power-settings">{totals.map(([label, number]) => <div key={label}><dt>{label}</dt><dd>{number}</dd></div>)}</dl>
      {data.workloads.length ? <p className="dock-note">Workload scan interval is {data.settings.scanInterval / 1000} s. CPU is averaged between scans.</p>
        : <Empty>Windows returned no supported workloads.</Empty>}
    </section>
  )
}
