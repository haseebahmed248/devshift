import { useState } from 'react'
import type { FormEvent } from 'react'
import { bestPerformanceMode, betterPerformanceMode } from '../shared/contracts.js'
import type { Dashboard, FileChoice, Settings, Workload } from '../shared/contracts.js'
import { Dialog, ErrorBanner } from './ui.js'

export function Preferences({ data, busy, error, close, save }: {
  data: Dashboard; busy: boolean; error: string | null; close: () => void; save: (settings: Settings) => void
}) {
  const [settings, setSettings] = useState(data.settings)
  return <Dialog title="Preferences" onClose={close} busy={busy}>
    <ErrorBanner error={error} />
    <form onSubmit={event => { event.preventDefault(); save(settings) }} className="form">
      <label>Gaming power plan
        <select value={settings.gamingPlan ?? ''} onChange={event => setSettings({ ...settings, gamingPlan: event.target.value || null })}>
          <option value="">Keep current plan</option>
          {settings.gamingPlan && !data.power.plans.some(plan => plan.id === settings.gamingPlan) &&
            <option value={settings.gamingPlan}>Unavailable plan</option>}
          {data.power.plans.map(plan => <option value={plan.id} key={plan.id}>{plan.name}</option>)}
        </select>
      </label>
      {data.powerMode && <label>Gaming power mode
        <select value={settings.gamingPowerMode ?? ''} onChange={event => setSettings({ ...settings, gamingPowerMode: event.target.value || null })}>
          <option value="">Keep current mode</option>
          <option value={betterPerformanceMode}>Better performance</option>
          <option value={bestPerformanceMode}>Best performance</option>
        </select>
      </label>}
      <label>Workload scan interval
        <select value={settings.scanInterval} onChange={event => setSettings({ ...settings, scanInterval: Number(event.target.value) })}>
          {[5, 10, 30, 60].map(seconds => <option key={seconds} value={seconds * 1000}>{seconds} seconds</option>)}
        </select>
      </label>
      <label className="inline-field"><input type="checkbox" checked={settings.minimizeToTray}
        onChange={event => setSettings({ ...settings, minimizeToTray: event.target.checked })} />Keep DevShift in the tray when I close the window</label>
      <div className="dialog-footer"><button type="button" className="button" onClick={close} disabled={busy}>Cancel</button>
        <button className="button primary" disabled={busy}>Save preferences</button></div>
    </form>
  </Dialog>
}

export function Register({ workloads, busy, error, close, done, run }: {
  workloads: Workload[]; busy: boolean; error: string | null; close: () => void; done: () => Promise<void>;
  run: (action: () => Promise<void>) => Promise<void>
}) {
  const [label, setLabel] = useState('')
  const [exe, setExe] = useState<FileChoice | null>(null)
  const [entry, setEntry] = useState<FileChoice | null>(null)
  const [services, setServices] = useState<string[]>([])
  const dependencies = workloads.filter(row => row.kind === 'service' && row.restoration !== 'Observation only')

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!exe || !entry) return
    void run(async () => {
      await window.devshift.registerNode({ label, executable: exe.token, entry: entry.token, dependencies: services })
      await done()
    })
  }
  function pick(kind: 'executable' | 'entry') {
    void run(async () => {
      const result = await window.devshift.pickFile(kind)
      if (result) (kind === 'executable' ? setExe : setEntry)(result)
    })
  }

  return <Dialog title="Add Node workload" onClose={close} busy={busy} wide>
    <ErrorBanner error={error} />
    <p className="dialog-summary">Choose a trusted project that registers a handler through <code>DEVSHIFT_SHUTDOWN_MODULE</code>. Approval lets DevShift launch the script and request a graceful shutdown.</p>
    <form className="form" onSubmit={submit}>
      <label>Workload name<input value={label} onChange={event => setLabel(event.target.value)} maxLength={70} required /></label>
      <div className="file-row"><div><strong>Node executable</strong><small className="path">{exe?.path ?? 'Select node.exe'}</small></div>
        <button type="button" className="button button-compact" onClick={() => pick('executable')} disabled={busy}>Browse</button></div>
      <div className="file-row"><div><strong>Project entry file</strong><small className="path">{entry?.path ?? 'Select a .js, .mjs, or .cjs file'}</small></div>
        <button type="button" className="button button-compact" onClick={() => pick('entry')} disabled={busy}>Browse</button></div>
      {dependencies.length > 0 && <fieldset><legend>Required Windows services</legend>{dependencies.map(service =>
        <label className="inline-field" key={service.id}><input type="checkbox" checked={services.includes(service.id)}
          onChange={event => setServices(current => event.target.checked ? [...current, service.id] : current.filter(id => id !== service.id))} />
          {service.label}</label>)}</fieldset>}
      <div className="dialog-footer"><button type="button" className="button" onClick={close} disabled={busy}>Cancel</button>
        <button className="button primary" disabled={busy || !label.trim() || !exe || !entry}>Approve workload</button></div>
    </form>
  </Dialog>
}

