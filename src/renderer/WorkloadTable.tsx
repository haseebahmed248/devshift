import { useState } from 'react'
import type { Workload } from '../shared/contracts.js'
import type { WorkloadGroup } from '../shared/workload-groups.js'
import { Empty, Icon, percent, privateMemory, type Glyph } from './ui.js'

interface TableActions {
  management?: boolean
  disabled?: boolean
  selected?: string | null
  open: (row: Workload) => void
  approve?: (id: string, value: boolean) => void
  launch?: (id: string) => void
}

const glyphs: Record<Workload['category'], Glyph> = {
  Editor: 'editor', Runtime: 'runtime', Database: 'database', Infrastructure: 'workloads', 'Build tool': 'settings', Emulator: 'dashboard',
}

function WorkloadRow({ row, group, expanded, toggle, role, management, disabled, selected, open, approve, launch }: TableActions & {
  row: Workload; group?: WorkloadGroup; expanded?: boolean; toggle?: () => void; role?: string
}) {
  const subtitle = group ? row.category + ' · ' + group.members.length + ' processes'
    : row.category + (row.kind === 'service' ? ' · Service' : '')
  const active = group ? !expanded && group.members.some(member => member.id === selected) : selected === row.id
  return (
    <tr className={[active && 'selected', role && 'process-member'].filter(Boolean).join(' ')}>
      <td>
        <button className="workload-name" aria-expanded={group ? expanded : undefined} aria-pressed={group ? undefined : active}
          aria-label={group ? (expanded ? 'Collapse ' : 'Expand ') + row.label + ', ' + group.members.length + ' processes'
            : role ? role + ', PID ' + row.pid : undefined}
          onClick={group ? toggle : () => open(row)}>
          {!role && <span className={'disclosure-slot' + (group ? ' has-children' : '')} aria-hidden="true" />}
          {!role && <span className={'workload-icon category-' + row.category.toLowerCase().replace(' ', '-')}>
            <Icon type={glyphs[row.category]} /></span>}
          <span><strong>{role ?? row.label}</strong>{!role && <small>{subtitle}</small>}</span>
        </button>
      </td>
      <td className="number" title={group ? 'Expand to see individual process IDs' : undefined}>{group ? '—' : row.pid ?? '—'}</td>
      <td className="number">{percent(group ? group.cpu : row.cpu)}</td>
      <td className="number">{privateMemory(group ? group.privateMemoryBytes : row.privateMemoryBytes)}</td>
      <td><span className={'row-state row-' + row.state}>{row.state === 'unknown' ? 'Unverified' : row.state}</span></td>
      {management && <td>
        {row.kind === 'service' && row.canApprove
          ? <label className="approve-control"><input type="checkbox" aria-label={'Manage ' + row.label} checked={row.approved}
            disabled={disabled} onChange={event => approve?.(row.id, event.target.checked)} />{row.approved ? 'Approved' : 'Approve'}</label>
          : row.kind === 'node' && row.canLaunch
            ? <button className="button button-compact" disabled={disabled} onClick={() => launch?.(row.id)}>Launch</button>
            : row.managed
              ? <span className="managed-label" title={row.restoration}>Gaming Mode</span>
              : <span className="muted">{row.approved ? 'Approved' : 'Observe only'}</span>}
      </td>}
    </tr>
  )
}

function GroupRows({ group, ...actions }: TableActions & { group: WorkloadGroup }) {
  const [expanded, setExpanded] = useState(false)
  if (group.members.length === 1) return <WorkloadRow row={group.root} {...actions} />
  return <>
    <WorkloadRow row={group.root} group={group} expanded={expanded} toggle={() => setExpanded(value => !value)} {...actions} />
    {expanded && group.members.map(member => <WorkloadRow key={member.id} row={member} {...actions}
      role={member.processRole ?? (member === group.root ? 'Parent process' : 'Editor process')} />)}
  </>
}

export function WorkloadTable({ groups, ...actions }: TableActions & { groups: WorkloadGroup[] }) {
  if (!groups.length) return <Empty>No matching development workloads found.</Empty>
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-label="Development workloads">
      <table>
        <thead><tr><th>Workload</th><th>PID</th><th title="Share of system CPU over the last workload scan interval">CPU</th>
          <th title="Physical memory private to each process">Private memory</th><th>Status</th>{actions.management && <th>Management</th>}</tr></thead>
        <tbody>{groups.map(group => <GroupRows key={group.root.id} group={group} {...actions} />)}</tbody>
      </table>
    </div>
  )
}
