import * as sqlite from 'node:sqlite'
import type { Settings } from '../shared/contracts.js'
import { capturedKinds, defaultSettings, UserError } from './model.js'
import type { Cycle, NodeSession, NodeWorkload } from './model.js'

const { Database = sqlite.DatabaseSync } = sqlite as typeof sqlite & { Database?: typeof sqlite.DatabaseSync }

export class Store {
  private readonly db: InstanceType<typeof Database>

  constructor(path: string) {
    this.db = new Database(path, { timeout: 3_000 })
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;')
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;' +
      'CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, updated TEXT NOT NULL, value TEXT NOT NULL) STRICT;',
    )
  }

  private read<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM preferences WHERE key=?').get(key)
    return row ? JSON.parse(String(row.value)) as T : fallback
  }

  private write(key: string, value: unknown) {
    this.db.prepare('INSERT INTO preferences VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(value))
  }

  // Fills in options added after the settings were saved.
  get settings(): Settings { return { ...defaultSettings, ...this.read<Partial<Settings>>('settings', {}) } }
  set settings(value: Settings) { this.write('settings', value) }

  get skips() {
    const value = this.read<unknown>('gaming-skips', [])
    return Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : []
  }
  set skips(value: string[]) { this.write('gaming-skips', value) }

  get approvals() { return this.read<Record<string, string>>('approved-services', {}) }

  approve(key: string, fingerprint: string | null) {
    const approvals = this.approvals
    if (fingerprint) approvals[key] = fingerprint
    else delete approvals[key]
    this.write('approved-services', approvals)
  }

  get configurations() { return this.read<NodeWorkload[]>('node-workloads', []) }
  set configurations(value: NodeWorkload[]) { this.write('node-workloads', value) }

  session(id: string) { return this.read<NodeSession | null>('node-session:' + id, null) }
  saveSession(id: string, session: NodeSession | null) { this.write('node-session:' + id, session) }

  active() {
    const id = this.read<string | null>('active', null)
    if (!id) return null
    const row = this.db.prepare('SELECT value FROM operations WHERE id=?').get(id)
    if (!row) throw new UserError('The active recovery snapshot is missing. Review the local database before switching.')
    const cycle = parseCycle(String(row.value))
    if (cycle.id !== id) throw new UserError('The active recovery snapshot has an invalid transaction ID.')
    return cycle
  }

  latest() {
    const row = this.db.prepare('SELECT value FROM operations ORDER BY updated DESC LIMIT 1').get()
    return row ? parseCycle(String(row.value)) : null
  }

  recent() {
    return this.db.prepare('SELECT value FROM operations ORDER BY updated DESC LIMIT 40').all()
      .flatMap(row => parseCycle(String(row.value)).history)
      .sort((a, b) => b.time.localeCompare(a.time))
      .slice(0, 120)
  }

  save(cycle: Cycle, active: boolean) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare('INSERT INTO operations VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET updated=excluded.updated,value=excluded.value')
        .run(cycle.id, cycle.updatedAt, JSON.stringify(cycle))
      this.write('active', active ? cycle.id : null)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  close() { this.db.close() }
}

function parseCycle(value: string): Cycle {
  const cycle = JSON.parse(value) as Cycle
  if (cycle?.schema !== 1 || !cycle.id || cycle.originalMode !== 'development' || !Array.isArray(cycle.steps)
    || !Array.isArray(cycle.history) || !['gaming', 'development'].includes(cycle.direction)) {
    throw new UserError('The recovery snapshot format is invalid. Review the local database before switching.')
  }

  for (const step of cycle.steps) {
    if (typeof step.id !== 'string' || !step.gaming || !step.development
      || !capturedKinds.includes(step.captured?.kind)) {
      throw new UserError('The recovery snapshot contains an invalid action.')
    }
  }
  return cycle
}
