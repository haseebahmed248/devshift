import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Activity, Layers, LayoutDashboard, RefreshCw } from 'lucide-react'
import logo from '../../assets/devshift.png'
import type { Dashboard, ReviewTarget, SwitchPreview, SwitchState, Workload } from '../shared/contracts.js'
import { groupWorkloads } from '../shared/workload-groups.js'
import { SwitchTransition } from './SwitchTransition.js'
import { WorkloadTable } from './WorkloadTable.js'
import { useStartupSplash } from './startup.js'
import { Preferences, Register } from './forms.js'
import { ModeScene, Performance, RecentActions, SwitchControls, WorkloadInspector, WorkloadStats } from './panels.js'
import { ActionList, bytes, clockTime, Dialog, Empty, ErrorBanner, HistoryList, Icon } from './ui.js'

type Page = 'Dashboard' | 'Workloads' | 'Activity'
type Filter = 'All' | 'Running' | 'Approved' | 'Installed'
type Overlay = 'preview' | 'progress' | 'preferences' | 'register' | null

const navigation = [
  { page: 'Dashboard', icon: LayoutDashboard, shortcut: '1' },
  { page: 'Workloads', icon: Layers, shortcut: '2' },
  { page: 'Activity', icon: Activity, shortcut: '3' },
] as const

function readableError(error: unknown) {
  const message = error instanceof Error ? error.message : 'DevShift could not complete this request.'
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

export function App() {
  const [page, setPage] = useState<Page>('Dashboard')
  const [filter, setFilter] = useState<Filter>('All')
  const [search, setSearch] = useState('')
  const [data, setData] = useState<Dashboard | null>(null)
  const [state, setState] = useState<SwitchState | null>(null)
  const [overlay, setOverlay] = useState<Overlay>(null)
  const [selection, setSelection] = useState<string | null>(null)
  const [preview, setPreview] = useState<SwitchPreview | null>(null)
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set())
  const [awaitingSwitch, setAwaitingSwitch] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const request = useRef(0)
  useStartupSplash(Boolean(data || error))

  const load = useCallback(async (refresh = false, clearError = false) => {
    const id = ++request.current
    try {
      if (!window.devshift) throw new Error('Start DevShift from the Windows desktop application.')
      const result = await window.devshift.dashboard(refresh)
      if (request.current !== id) return
      setData(result)
      setState(result.state)
      if (clearError) setError(null)
    } catch (problem) {
      if (request.current === id) setError(readableError(problem))
    }
  }, [])

  const run = useCallback(async (action: () => Promise<void>) => {
    setWorking(true)
    setError(null)
    try { await action() }
    catch (problem) { setError(readableError(problem)) }
    finally { setWorking(false) }
  }, [])

  const review = useCallback((target: ReviewTarget) => {
    void run(async () => {
      const next = await window.devshift.review(target)
      setPreview(next)
      setSkipped(new Set(next.items.filter(item => item.selected === false).map(item => item.id)))
      setOverlay('preview')
    })
  }, [run])

  useEffect(() => {
    void load()
    if (!window.devshift) return
    const removeState = window.devshift.onProgress(next => {
      ++request.current
      if (next.busy) setAwaitingSwitch(false)
      setState(next)
    })
    const removeTray = window.devshift.onReview(review)
    const removeScan = window.devshift.onScanDue(() => { void load(true) })
    return () => { removeState(); removeTray(); removeScan() }
  }, [load, review])

  const disabled = working || Boolean(state?.busy)
  const locked = disabled || Boolean(state?.hasSnapshot)
  const go = useCallback((next: Page) => {
    if (page === next) return
    setPage(next)
    setSelection(null)
    setFilter('All')
    setSearch('')
    document.getElementById('nav-' + next)?.focus({ preventScroll: true })
  }, [page])
  const preferences = useCallback(() => { setError(null); setOverlay('preferences') }, [])
  const refresh = useCallback(() => {
    setRefreshing(true)
    void load(true, true).finally(() => setRefreshing(false))
  }, [load])

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (overlay || event.altKey || event.metaKey || document.getElementById('root')?.inert) return
      if (event.key === 'F5' && !disabled && !refreshing) { event.preventDefault(); refresh(); return }
      if (!event.ctrlKey) return
      const tab = navigation.find(link => link.shortcut === event.key)
      if (tab) { event.preventDefault(); go(tab.page) }
      else if (event.key === ',' && data && !disabled) { event.preventDefault(); preferences() }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [overlay, disabled, refreshing, data, go, preferences, refresh])

  function dismiss() {
    const afterSwitch = overlay === 'progress'
    setOverlay(null)
    setError(null)
    // The mode button that started the switch is now disabled, so focus would otherwise fall back to the page.
    if (afterSwitch) requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.mode-switch button:not(:disabled)')?.focus())
  }
  function confirm() {
    if (!preview) return
    setAwaitingSwitch(true)
    setOverlay('progress')
    void run(async () => {
      const next = await window.devshift.execute(preview.token, [...skipped])
      setAwaitingSwitch(false)
      setState(next)
      await load()
    })
  }
  function toggleAction(id: string, selected: boolean) {
    setSkipped(current => {
      const next = new Set(current)
      if (selected) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function openDetails(row: Workload) { setSelection(row.id); setError(null) }
  function approve(id: string, approved: boolean) {
    void run(async () => { await window.devshift.approve(id, approved); await load() })
  }
  function launch(id: string) {
    void run(async () => { try { await window.devshift.launchNode(id) } finally { await load() } })
  }

  const groups = useMemo(() => groupWorkloads(data?.workloads ?? []), [data?.workloads])
  const running = groups.filter(group => group.root.state === 'running')
  const query = search.trim().toLowerCase()
  const searchable = (item: { label?: string; name?: string; category?: string }) =>
    [item.label, item.name, item.category].some(value => value?.toLowerCase().includes(query))
  const visible = groups.filter(({ root }) => searchable(root) && (filter === 'All'
    || (filter === 'Running' && root.state === 'running') || (filter === 'Approved' && root.approved)))
  const installed = data?.installed.filter(searchable) ?? []
  const selected = data?.workloads.find(row => row.id === selection)
  const canRecover = state?.hasSnapshot && ['RECOVERY_REQUIRED', 'PARTIAL_SUCCESS', 'FAILED'].includes(state.phase)
  const chosen = preview?.items.filter(item => !skipped.has(item.id)) ?? []
  const frees = chosen.reduce((total, item) => total + (item.memoryBytes ?? 0), 0)
  const actions = (state?.progress ?? []).filter(item => !item.id.startsWith('blocked:'))
  const finished = actions.filter(item => item.status !== 'pending' && item.status !== 'running').length

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="window-chrome">
        <div className="brand"><img src={logo} alt="" width="23" height="23" /><span>DevShift</span></div>
      </header>

      <div className="desktop-body">
        <aside className="rail" aria-label="DevShift">
          <nav aria-label="Main views" data-view={page}>
            {navigation.map(({ page: name, icon: NavIcon, shortcut }) => <button key={name} id={'nav-' + name} className={'rail-item' + (page === name ? ' rail-active' : '')}
              aria-label={name} aria-current={page === name ? 'page' : undefined}
              title={name + ' (Ctrl+' + shortcut + ')'} onClick={() => go(name)}>
              <span className="rail-glyph"><NavIcon size={19} strokeWidth={1.8} aria-hidden="true" /></span><span>{name}</span>
            </button>)}
          </nav>
          <div className="rail-end">
            <button className="rail-item" aria-label="Settings" title="Settings (Ctrl+,)" disabled={!data || disabled}
              onClick={preferences}><span className="rail-glyph"><Icon type="settings" /></span><span>Settings</span></button>
            <button className="rail-item quit-button" aria-label="Quit DevShift" title="Quit DevShift" disabled={disabled}
              onClick={() => { void run(() => window.devshift.quit()) }}><span className="rail-glyph"><Icon type="exit" /></span><span>Quit</span></button>
          </div>
        </aside>

        <main id="main" className="workspace">
          <div className="commandbar">
            <h1>{page}</h1>
            <div className="command-actions">
              {page === 'Workloads' && <button className="button primary" disabled={locked || !data}
                onClick={() => { setError(null); setOverlay('register') }}><Icon type="add" />Add Node workload</button>}
              <button className="button command-refresh" onClick={refresh} disabled={refreshing || disabled} title="Refresh (F5)">
                <RefreshCw size={16} strokeWidth={1.8} aria-hidden="true" />{refreshing ? 'Scanning' : 'Refresh'}
              </button>
            </div>
          </div>

          <div key={page} className="workbench">
            <div className="main-pane">
              {!overlay && <ErrorBanner error={error} />}
              {!data || !state ? <div className="surface"><Empty>{error ? 'Use Refresh to scan Windows again.' : 'Reading Windows workloads and power plans…'}</Empty></div>
                : <>
                  {canRecover && <section className="recovery">
                    <div><strong>{state.phase === 'RECOVERY_REQUIRED' ? 'Interrupted switch' : 'Recovery options available'}</strong><p>{state.summary}</p></div>
                    <div className="recovery-buttons">
                      <button className="button button-compact" disabled={disabled} onClick={() => review('resume')}>Retry remaining</button>
                      <button className="button button-compact" disabled={disabled} onClick={() => review('development')}>Review restoration</button>
                      <button className="button button-compact" disabled={disabled} onClick={() => review('keep')}>Keep current state</button>
                    </div>
                  </section>}

                  {page === 'Dashboard' && <ModeScene state={state} />}
                </>}
              {page === 'Dashboard' && window.devshift && <Performance />}
              {data && state && <>
                  {page === 'Dashboard' && <>
                    <section className="surface workload-surface">
                      <div className="pane-title">
                        <div><h2>Running workloads</h2><p>{running.length} running · {running.filter(group => group.root.approved).length} approved</p></div>
                        <button className="text-button" onClick={() => go('Workloads')}>View workloads<Icon type="arrow" /></button>
                      </div>
                      <WorkloadTable groups={running.slice(0, 6)} open={openDetails} selected={selection} />
                    </section>
                  </>}

                  {page === 'Workloads' && <section className="surface workload-surface">
                    <div className="filters">
                      <div className="filter-group" role="group" aria-label="Filter workloads">
                        {(['All', 'Running', 'Approved', 'Installed'] as Filter[]).map(value => <button key={value}
                          aria-pressed={filter === value} onClick={() => { setFilter(value); setSelection(null) }}>{value}</button>)}
                      </div>
                      <input type="search" aria-label="Search workloads" placeholder="Search workloads" value={search} onChange={event => setSearch(event.target.value)} />
                    </div>
                    <div key={filter} className="filter-results">{filter === 'Installed'
                      ? installed.length ? <ul className="installed-list">{installed.map(tool =>
                        <li key={tool.name}><strong>{tool.name}</strong><span>{tool.version ?? 'Version unavailable'}</span><span>{tool.source}</span></li>)}</ul>
                        : <Empty>No matching installed tools found.</Empty>
                      : <WorkloadTable groups={visible} open={openDetails} selected={selection} management disabled={locked}
                        approve={approve} launch={launch} />}</div>
                  </section>}

                  {page === 'Activity' && <section className="surface">
                    <div className="pane-title"><h2>Switch history</h2></div>
                    <HistoryList entries={data.history} />
                  </section>}
                </>}
            </div>

            <aside className="inspector" aria-label="Workspace inspector">
              {data && state && (selected
                ? <WorkloadInspector row={selected} disabled={locked} close={() => setSelection(null)}
                  remove={() => { void run(async () => { await window.devshift.removeNode(selected.id); setSelection(null); await load() }) }}
                  revoke={() => approve(selected.id, false)} />
                : page === 'Workloads' ? <WorkloadStats data={data} runningCount={running.length} />
                  : <>
                    <SwitchControls data={data} state={state} disabled={disabled} review={review} preferences={preferences} />
                    {page === 'Dashboard' && <RecentActions data={data} open={() => go('Activity')} />}
                  </>)}
            </aside>
          </div>
        </main>
      </div>

      <footer className="statusbar">
        <span className="status-entry"><i className={error ? 'connection-error' : data ? 'connection-ready' : 'connection-waiting'} />
          {error ? 'Needs attention' : data ? 'Local workstation' : 'Connecting to Windows'}</span>
        {data && <><span className="status-entry system-build">Windows build {data.build}</span>
          <span className="status-entry scan-clock">Scan {clockTime(data.scannedAt)}</span></>}
      </footer>

      {overlay === 'preview' && preview && <Dialog title={preview.keep ? 'Keep current state' : preview.recovery ? 'Review recovery'
        : preview.direction === 'gaming' ? 'Review Gaming Mode' : 'Review Development Mode'} onClose={dismiss} wide>
        <ErrorBanner error={error} />
        {!preview.keep && preview.direction === 'gaming' && frees > 0 &&
          <p className="preview-total">Frees about <strong>{bytes(frees)}</strong> of memory</p>}
        {!preview.keep && <ActionList items={preview.items} showStatus={false} skipped={skipped} toggle={toggleAction} />}
        {preview.notices.length > 0 && <ul className="notice-list">{preview.notices.map((notice, index) => <li key={index}>{notice}</li>)}</ul>}
        <div className="dialog-footer"><button className="button" onClick={dismiss}>Cancel</button>
          <button className="button primary" onClick={confirm} disabled={disabled}>{preview.keep ? 'Keep current state'
            : preview.direction === 'gaming' ? 'Confirm switch' : 'Confirm restoration'}</button></div>
      </Dialog>}

      {overlay === 'progress' && <Dialog title={working || state?.busy ? 'Switching environment' : 'Switch result'}
        onClose={dismiss} busy={disabled} wide>
        <ErrorBanner error={error} />
        {preview && !preview.keep
          ? <SwitchTransition key={preview.token} direction={preview.direction} state={awaitingSwitch ? null : state} error={error} />
          : <p className="dialog-summary" aria-live="polite">{state?.summary}</p>}
        <ActionList items={awaitingSwitch ? chosen : state?.progress ?? []} showStatus />
        {!awaitingSwitch && actions.length > 0 && <p className="sr-only" role="status">{finished} of {actions.length} actions finished</p>}
        <div className="dialog-footer"><button className="button primary" onClick={dismiss} disabled={disabled}>Done</button></div>
      </Dialog>}

      {overlay === 'preferences' && data && <Preferences data={data} busy={disabled} error={error} close={dismiss}
        save={settings => { void run(async () => { await window.devshift.preferences(settings); await load(); dismiss() }) }} />}

      {overlay === 'register' && data && <Register workloads={data.workloads} busy={disabled} error={error} close={dismiss} run={run}
        done={async () => { await load(); dismiss() }} />}
    </div>
  )
}
