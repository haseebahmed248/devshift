import { randomUUID } from 'node:crypto'
import type { Dashboard, Mode, OperationItem, Phase, ReviewTarget, Settings, SwitchPreview, SwitchState } from '../shared/contracts.js'
import { decide, planGaming, verify as verifyStep } from './actions.js'
import { sameFile } from './discovery.js'
import { errorMessage, ongoing, pending, serviceKey, timestamp, UserError } from './model.js'
import type { Cycle, Device, Host, JournalStep, NodeWorkload } from './model.js'
import type { Store } from './store.js'

interface Review {
  token: string
  expires: number
  target: ReviewTarget
  direction: Mode
  cycle: Cycle
  steps: JournalStep[]
  /** Plaintext until sealed at execution. Never journaled. */
  secrets: Map<string, string>
}

const phaseName = (direction: Mode) => direction === 'gaming' ? 'Gaming Mode' : 'Development Mode'
const preparation = (direction: Mode): Phase => direction === 'gaming' ? 'PREPARING_GAMING' : 'PREPARING_DEVELOPMENT'
const switching = (direction: Mode): Phase => direction === 'gaming' ? 'SWITCHING_TO_GAMING' : 'RESTORING_DEVELOPMENT'
const keyOf = (step: JournalStep) => step.key ?? step.id
const canRetry = (step: JournalStep, direction: Mode) =>
  direction === 'gaming' ? ['pending', 'running', 'failed'].includes(step.gaming.status)
    : step.gaming.effect !== 'none' && !['succeeded', 'skipped'].includes(step.development.status)

function item(step: JournalStep, direction: Mode): OperationItem {
  const outcome = step[direction]
  return { id: step.id, label: step.label, detail: direction === 'gaming' ? step.forward : step.backward,
    status: outcome.status, message: outcome.message }
}

export class Engine {
  private busy = false
  private cycle: Cycle | null
  private reviewPlan: Review | null = null
  private device: Device | null = null
  private scanPromise: Promise<Device> | null = null
  private installedAt = 0

  constructor(private readonly store: Store, private readonly host: Host, private readonly publish: (state: SwitchState) => void = () => {}) {
    this.cycle = store.active()
    if (this.cycle && ongoing.has(this.cycle.phase)) {
      this.cycle.phase = 'RECOVERY_REQUIRED'
      this.cycle.summary = 'An earlier switch was interrupted. Review the saved actions before continuing.'
      this.log(this.cycle, 'Recovery required', this.cycle.summary, 'failed')
      this.save(this.cycle)
    }
  }

  state(): SwitchState {
    const cycle = this.cycle
    if (!cycle) {
      const last = this.store.latest()
      return {
        mode: 'development', phase: last?.phase === 'PARTIAL_SUCCESS' ? last.phase : 'DEVELOPMENT',
        direction: last?.direction ?? null, busy: this.busy, hasSnapshot: false,
        transactionId: last?.id ?? null, progress: last?.steps.filter(step => step.gaming.effect !== 'none')
          .map(step => item(step, 'development')) ?? [],
        updatedAt: last?.updatedAt ?? null, summary: last?.summary ?? 'Ready to review a switch.',
      }
    }
    const hasChanges = cycle.steps.some(step => step.gaming.effect !== 'none')
    const mode = cycle.phase === 'GAMING' || cycle.phase === 'PARTIAL_SUCCESS' || hasChanges ? 'gaming' : 'development'
    return {
      mode, phase: cycle.phase, direction: cycle.direction, busy: this.busy, hasSnapshot: true,
      transactionId: cycle.id,
      progress: [
        ...cycle.steps.filter(step => cycle.direction === 'gaming' || step.gaming.effect !== 'none').map(step => item(step, cycle.direction)),
        ...(cycle.direction === 'gaming' ? cycle.blocked.map((message, index) => ({
          id: 'blocked:' + index, label: 'Skipped approved change', detail: '', message, status: 'skipped' as const,
        })) : []),
      ],
      updatedAt: cycle.updatedAt, summary: cycle.summary,
    }
  }

  private async read(): Promise<Device> {
    if (this.scanPromise) return this.scanPromise
    const installed = Date.now() - this.installedAt > 120_000
    this.scanPromise = this.host.read(installed).then(device => {
      this.device = device
      if (installed) this.installedAt = Date.now()
      return device
    }).finally(() => { this.scanPromise = null })
    return this.scanPromise
  }

  async dashboard(refresh = false): Promise<Dashboard> {
    const age = this.device ? Date.now() - Date.parse(this.device.scannedAt) : Infinity
    const device = !this.device || (!this.busy && (refresh || age >= this.store.settings.scanInterval)) ? await this.read() : this.device
    return {
      state: this.state(), settings: this.store.settings, workloads: device.workloads,
      installed: device.scan.installed, power: device.scan.power, powerMode: device.scan.powerMode ?? null,
      build: device.scan.build, scannedAt: device.scannedAt, history: this.store.recent(),
    }
  }

  private log(cycle: Cycle, title: string, message: string, status: OperationItem['status']) {
    cycle.history.push({ id: randomUUID(), time: timestamp(), title, message, status })
  }

  private save(cycle: Cycle, active = true) {
    cycle.updatedAt = timestamp()
    this.store.save(cycle, active)
    this.cycle = active ? cycle : null
    this.publish(this.state())
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.busy) throw new UserError('DevShift is already working on another request.')
    this.busy = true
    try { return await work() } finally { this.busy = false; this.publish(this.state()) }
  }

  private prepareGaming(device: Device) {
    const plan = planGaming(device, this.store.settings, this.store.approvals)
    const cycle: Cycle = {
      schema: 1, id: randomUUID(), originalMode: 'development', originalPower: device.scan.power.active,
      createdAt: timestamp(), updatedAt: timestamp(), direction: 'gaming', phase: 'PREPARING_GAMING',
      notices: plan.notices, blocked: plan.blocked, history: [], summary: 'Saving a recovery snapshot.',
      steps: plan.steps.map(step => ({
        id: step.id, key: step.key, label: step.label, forward: step.forward, backward: step.backward, captured: step.captured,
        gaming: pending(), development: pending(),
      })),
    }
    return {
      cycle,
      secrets: new Map(plan.steps.flatMap(step => step.secret ? [[step.id, step.secret] as const] : [])),
      estimates: new Map(plan.steps.map(step => [step.id, step.memoryBytes] as const)),
    }
  }

  async review(target: ReviewTarget): Promise<SwitchPreview> {
    return this.exclusive(async () => {
      const active = this.cycle
      const keep = target === 'keep'
      if (keep) {
        if (!active || !['RECOVERY_REQUIRED', 'FAILED', 'PARTIAL_SUCCESS'].includes(active.phase))
          throw new UserError('There is no pending recovery to close.')
        const token = randomUUID()
        this.reviewPlan = { token, target, expires: Date.now() + 120_000, cycle: active, steps: [], direction: 'development', secrets: new Map() }
        return { token, direction: 'development', recovery: true, keep: true, items: [],
          notices: ['This closes recovery and keeps all current Windows settings and workloads. You can review the saved history afterward.'] }
      }
      const device = await this.read()
      let cycle: Cycle
      let direction: Mode
      let secrets = new Map<string, string>()
      let estimates: Map<string, number | null> | null = null
      if (!active && target === 'gaming') {
        ({ cycle, secrets, estimates } = this.prepareGaming(device))
        direction = 'gaming'
      } else if (active && target === 'development') {
        cycle = active
        direction = 'development'
      } else if (active && target === 'resume' && ['RECOVERY_REQUIRED', 'FAILED', 'PARTIAL_SUCCESS'].includes(active.phase)) {
        cycle = active
        direction = active.direction
      } else throw new UserError('This switch is unavailable in the current mode.')

      const steps = cycle.steps.filter(step => canRetry(step, direction))
      if (direction === 'development') steps.reverse()
      const token = randomUUID()
      this.reviewPlan = { token, target, expires: Date.now() + 120_000, cycle, steps, direction, secrets }
      const skipped = estimates ? new Set(this.store.skips) : new Set<string>()
      const notices = direction === 'gaming' ? [...cycle.blocked, ...cycle.notices] : [
        'Projects and services from the saved snapshot restart only if their current configuration still matches.',
        'A different power plan selected since the switch stays in place.',
      ]
      if (active?.phase === 'RECOVERY_REQUIRED' || steps.some(step => step.gaming.effect === 'possible'))
        notices.unshift('A previous action may have changed Windows before verification. DevShift will check current state before applying recovery.')
      return {
        token, direction, recovery: active?.phase === 'RECOVERY_REQUIRED' || target === 'resume', keep: false,
        items: steps.map(step => ({
          ...item(step, direction), status: 'pending', message: '', selected: !skipped.has(keyOf(step)),
          ...(estimates ? { memoryBytes: estimates.get(step.id) ?? null } : {}),
        })),
        notices,
      }
    })
  }

  private rememberChoices(steps: JournalStep[], skipped: Set<string>) {
    const skips = new Set(this.store.skips)
    for (const step of steps) {
      if (skipped.has(step.id)) skips.add(keyOf(step))
      else skips.delete(keyOf(step))
    }
    this.store.skips = [...skips].slice(-200)
  }

  async execute(token: string, skip: readonly string[] = []): Promise<SwitchState> {
    await this.exclusive(async () => {
      const review = this.reviewPlan
      if (!review || review.token !== token || Date.now() > review.expires)
        throw new UserError('The switch preview expired. Review the current workload state again.')
      const reviewed = new Set(review.steps.map(step => step.id))
      if (skip.some(id => !reviewed.has(id))) throw new UserError('The switch preview changed. Review it again.')

      this.reviewPlan = null
      const { cycle, direction } = review
      const skipped = new Set(skip)
      if (review.target === 'keep' && this.cycle?.id === cycle.id) {
        cycle.direction = 'development'
        cycle.phase = 'PARTIAL_SUCCESS'
        cycle.summary = 'Recovery closed. Current Windows settings and workloads were preserved.'
        for (const step of cycle.steps.filter(entry => canRetry(entry, 'development'))) {
          step.development = { ...step.development, status: 'skipped', message: 'Preserved the current state.', time: timestamp() }
        }
        this.log(cycle, 'Current state kept', cycle.summary, 'skipped')
        this.save(cycle, false)
        return
      }
      const device = await this.read()
      const firstAttempt = !this.cycle
      if (review.target === 'gaming' && firstAttempt) {
        const fresh = this.prepareGaming(device).cycle
        if (JSON.stringify([fresh.steps, fresh.blocked, fresh.originalPower]) !== JSON.stringify([cycle.steps, cycle.blocked, cycle.originalPower]))
          throw new UserError('Approved workloads or power settings changed after review. Open an updated preview.')
        this.rememberChoices(cycle.steps, skipped)
        cycle.steps = cycle.steps.filter(step => !skipped.has(step.id))
        for (const step of cycle.steps) {
          const secret = review.secrets.get(step.id)
          if (secret && (step.captured.kind === 'app' || step.captured.kind === 'devserver')) step.captured.sealed = await this.host.seal(secret)
        }
      } else if (!this.cycle || this.cycle.id !== cycle.id) {
        throw new UserError('The saved transaction changed. Review it again.')
      }
      const steps = review.target === 'gaming' && firstAttempt ? cycle.steps : review.steps.filter(step => !skipped.has(step.id))

      cycle.direction = direction
      cycle.phase = preparation(direction)
      cycle.summary = direction === 'gaming' ? 'Saving the recovery snapshot.' : 'Checking the saved recovery snapshot.'
      this.log(cycle, direction === 'gaming' ? 'Gaming switch requested' : 'Restore requested', cycle.summary, 'running')
      if (firstAttempt) for (const reason of cycle.blocked) this.log(cycle, 'Skipped approved change', reason, 'skipped')
      if (!firstAttempt) for (const step of review.steps.filter(entry => skipped.has(entry.id))) {
        step[direction] = { ...step[direction], status: 'skipped', message: 'Skipped at your request.', time: timestamp() }
        this.log(cycle, step.label, 'Skipped at your request.', 'skipped')
      }
      this.save(cycle)
      cycle.phase = switching(direction)
      cycle.summary = direction === 'gaming' ? 'Applying approved changes.' : 'Restoring captured workloads.'
      this.save(cycle)

      for (const step of steps) await this.apply(cycle, step, direction)
      let verificationFailed = false
      try { this.verify(cycle, direction, await this.read()) }
      catch (error) {
        verificationFailed = true
        this.log(cycle, 'Verification unavailable', errorMessage(error, 'DevShift could not read Windows after switching.'), 'failed')
      }

      const applicable = cycle.steps.filter(step => direction === 'gaming' || step.gaming.effect !== 'none')
      const failed = verificationFailed || applicable.some(step => step[direction].status === 'failed')
      const skippedSteps = applicable.some(step => step[direction].status === 'skipped')
      const completed = applicable.filter(step => step[direction].status === 'succeeded').length
      const partial = skippedSteps || (direction === 'gaming' && cycle.blocked.length > 0) || failed
      cycle.phase = failed && !completed ? 'FAILED' : partial ? 'PARTIAL_SUCCESS' : direction === 'gaming' ? 'GAMING' : 'DEVELOPMENT'
      cycle.summary = failed ? (completed ? 'Some actions completed. Review the failed steps and recovery options.'
        : 'DevShift could not complete the requested changes. Review the saved recovery options.')
        : partial ? phaseName(direction) + ' completed with skipped changes.'
          : !applicable.length ? phaseName(direction) + ' is active. No system changes were needed.'
            : phaseName(direction) + ' is active. Windows state was verified.'
      this.log(cycle, phaseName(direction), cycle.summary, failed ? 'failed' : partial ? 'skipped' : 'succeeded')
      this.save(cycle, direction === 'gaming' || failed)
    })
    return this.state()
  }

  private async apply(cycle: Cycle, step: JournalStep, direction: Mode) {
    const prior = step[direction]
    let effect = prior.effect
    const report = (status: OperationItem['status'], message: string) => {
      step[direction] = { status, message, effect, time: timestamp() }
      this.log(cycle, step.label, message, status)
      this.save(cycle)
    }

    try {
      const device = await this.read()
      const decision = await decide(step.captured, device, direction, this.host)
      if (decision.type === 'present') {
        if (prior.effect === 'possible') effect = 'verified'
        return report('succeeded', decision.message)
      }
      if (decision.type === 'skip') return report('skipped', decision.message)

      // Record the intent before touching Windows, so an interruption is recoverable.
      effect = 'possible'
      step[direction] = { status: 'running', message: 'Waiting for Windows verification.', effect, time: timestamp() }
      this.save(cycle)
      const result = await decision.run()
      if (result.skipped) return report('skipped', result.message ?? 'Windows left it unchanged.')
      effect = result.changed ? 'verified' : prior.effect
      report('succeeded', result.changed ? decision.success : 'The requested state was already present.')
    } catch (error) {
      if (error instanceof UserError && error.unchanged) effect = prior.effect
      if (step[direction].status === 'running' || step[direction].status === prior.status)
        report('failed', errorMessage(error, 'The action could not be verified. Inspect current Windows state before retrying.'))
      else throw error
    }
  }

  private verify(cycle: Cycle, direction: Mode, device: Device) {
    for (const step of cycle.steps.filter(entry => entry[direction].status === 'succeeded')) {
      if (verifyStep(step.captured, device, direction)) continue
      const message = 'The final check found a different state. Review Windows before retrying.'
      step[direction] = { ...step[direction], status: 'failed', message, time: timestamp() }
      this.log(cycle, step.label, message, 'failed')
      this.save(cycle)
    }
  }

  private editAllowed() {
    if (this.cycle) throw new UserError('Finish the current switch or restoration before changing approvals.')
    this.reviewPlan = null
  }

  async approve(id: string, approved: boolean) {
    await this.exclusive(async () => {
      this.editAllowed()
      if (approved) {
        const device = await this.read()
        const service = device.scan.services.find(candidate => serviceKey(candidate.name) === id)
        if (!service || !service.supported || !service.canControl)
          throw new UserError('This service cannot be approved with the current Windows permissions.')
        this.store.approve(id, service.fingerprint)
      } else this.store.approve(id, null)
      this.device = null
    })
  }

  async preferences(settings: Settings) {
    await this.exclusive(async () => {
      this.reviewPlan = null
      if (settings.gamingPlan && !(await this.read()).scan.power.plans.some(plan => plan.id === settings.gamingPlan))
        throw new UserError('Select a power plan currently installed in Windows.')
      this.store.settings = settings
    })
  }

  async registerNode(work: () => Promise<NodeWorkload>) {
    await this.exclusive(async () => {
      this.editAllowed()
      const config = await work()
      const device = await this.read()
      if (config.dependencies.some(name => !device.scan.services.some(service => service.supported && service.name.toLowerCase() === name)))
        throw new UserError('A selected service dependency is unavailable.')
      if (this.store.configurations.length >= 24) throw new UserError('Remove an unused project before adding another one.')
      if (this.store.configurations.some(existing => sameFile(existing.entry, config.entry)))
        throw new UserError('This project entry file is already approved.')
      this.store.configurations = [...this.store.configurations, config]
      this.device = null
    })
  }

  async launchNode(id: string) {
    await this.exclusive(async () => {
      this.editAllowed()
      const device = await this.read()
      const node = device.nodes.find(entry => entry.configuration.id === id)
      if (!node || node.state !== 'stopped') throw new UserError('This project is already running or unavailable.')
      try { await this.host.startNode(node.configuration, device.scan) }
      finally { this.device = null }
    })
  }

  async removeNode(id: string) {
    await this.exclusive(async () => {
      this.editAllowed()
      const node = (await this.read()).nodes.find(entry => entry.configuration.id === id)
      if (!node || node.state !== 'stopped') throw new UserError('The project must be stopped before its approval can be removed.')
      this.store.configurations = this.store.configurations.filter(config => config.id !== id)
      this.store.saveSession(id, null)
      this.device = null
    })
  }
}
