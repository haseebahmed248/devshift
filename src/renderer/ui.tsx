import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import type { OperationItem, TimelineEntry } from '../shared/contracts.js'

export type Glyph = 'dashboard' | 'workloads' | 'activity' | 'settings' | 'arrow' | 'close'
  | 'power' | 'editor' | 'runtime' | 'database' | 'add' | 'switch' | 'exit'

export function Icon({ type }: { type: Glyph }) {
  return <span className={'icon icon-' + type} aria-hidden="true" />
}

export function bytes(value: number | null, unit: 'auto' | 'gb' = 'auto') {
  if (value === null) return '—'
  if (unit === 'gb' || value >= 1024 ** 3) return (value / 1024 ** 3).toFixed(1) + ' GB'
  return Math.round(value / 1024 ** 2).toLocaleString() + ' MB'
}

const megabytes = new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const percentage = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 })

export function privateMemory(value: number | null) {
  return value === null ? '—' : megabytes.format(value / 1024 ** 2) + ' MB'
}

export function percent(value: number | null) {
  return value === null ? '—' : percentage.format(value) + '%'
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
export function displayTime(date: string | null) {
  return date ? dateFormat.format(new Date(date)) : 'No recorded switch'
}
export function clockTime(date: string) {
  return new Date(date).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })
}

export function Dialog({ title, children, onClose, wide = false, busy = false }: {
  title: string; children: ReactNode; onClose: () => void; wide?: boolean; busy?: boolean
}) {
  const element = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const current = element.current
    current?.showModal()
    return () => { if (current?.open) current.close() }
  }, [])
  return (
    <dialog ref={element} className={wide ? 'dialog dialog-wide' : 'dialog'} aria-labelledby="dialog-title"
      onCancel={event => { event.preventDefault(); if (!busy) onClose() }}>
      <div className="dialog-heading">
        <h2 id="dialog-title">{title}</h2>
        <button className="icon-button" type="button" aria-label="Close" disabled={busy} onClick={onClose}><Icon type="close" /></button>
      </div>
      {children}
    </dialog>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>
}

const statusLabels = { pending: 'Pending', running: 'In progress', succeeded: 'Completed', skipped: 'Skipped', failed: 'Failed' }
export function OutcomeBadge({ status }: { status: OperationItem['status'] }) {
  return <span className={'status status-' + status}>{statusLabels[status]}</span>
}

export function ActionList({ items, showStatus, skipped, toggle }: {
  items: OperationItem[]; showStatus: boolean; skipped?: ReadonlySet<string>; toggle?: (id: string, selected: boolean) => void
}) {
  if (!items.length) return <Empty>No workload or power changes are planned.</Empty>
  return (
    <ul className="action-list">
      {items.map(item => {
        const text = <div><strong>{item.label}</strong><p>{item.message || item.detail}</p></div>
        const off = !!toggle && !!skipped?.has(item.id)
        return <li key={item.id} className={off ? 'action-off' : undefined}>
          {toggle
            ? <label className="action-select"><input type="checkbox" checked={!off}
              onChange={event => toggle(item.id, event.target.checked)} />{text}</label>
            : text}
          {!!item.memoryBytes && <span className="action-memory" title="Estimated memory this frees">
            <span className="sr-only">Frees about </span>{bytes(item.memoryBytes)}</span>}
          {showStatus && <OutcomeBadge status={item.status} />}
        </li>
      })}
    </ul>
  )
}

export function HistoryList({ entries }: { entries: TimelineEntry[] }) {
  if (!entries.length) return <Empty>Mode switches and recovery attempts will appear here.</Empty>
  return (
    <ul className="history-list">
      {entries.map(entry => (
        <li key={entry.id}>
          <span className={'history-marker marker-' + entry.status} aria-hidden="true" />
          <div><strong>{entry.title}</strong><p>{entry.message}</p></div>
          <div className="history-result"><OutcomeBadge status={entry.status} /><time dateTime={entry.time}>{displayTime(entry.time)}</time></div>
        </li>
      ))}
    </ul>
  )
}

export function ErrorBanner({ error }: { error: string | null }) {
  return error && <div className="error-banner" role="alert">{error}</div>
}
