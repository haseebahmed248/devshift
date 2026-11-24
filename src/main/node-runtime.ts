import { spawn } from 'node:child_process'
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { basename, dirname, extname, isAbsolute } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { matchingNode, sameFile } from '../core/discovery.js'
import { sameIdentity, UserError } from '../core/model.js'
import type { NodeObservation, NodeSession, NodeWorkload, RawProcess, WindowsScan } from '../core/model.js'
import type { Store } from '../core/store.js'
import type { Windows } from './windows.js'

export interface Secrets {
  seal: (value: string) => Promise<string>
  unseal: (value: string) => Promise<string>
}

interface Reply { pid: number; ready: boolean; accepted: boolean; proof: string }

function proof(key: string, message: string) {
  return createHmac('sha256', key).update(message).digest('hex')
}

async function hash(path: string) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

function pipe(session: NodeSession, key: string, operation: 'ping' | 'stop'): Promise<Reply | null> {
  return new Promise(resolve => {
    const nonce = randomBytes(16).toString('hex')
    const socket = createConnection('\\\\.\\pipe\\devshift-' + session.id)
    const finish = (value: Reply | null) => { socket.destroy(); resolve(value) }
    socket.setEncoding('utf8')
    socket.setTimeout(operation === 'ping' ? 600 : 16_000, () => finish(null))
    socket.on('error', () => finish(null))
    socket.on('end', () => finish(null))
    socket.once('connect', () => socket.write(JSON.stringify({ nonce, operation, proof: proof(key, operation + '|' + nonce) }) + '\n'))
    let input = ''
    socket.on('data', chunk => {
      input += chunk
      if (input.length > 1024) return finish(null)
      if (!input.endsWith('\n')) return
      try {
        const reply = JSON.parse(input) as Reply
        if (!Number.isInteger(reply.pid) || reply.pid <= 0 || typeof reply.ready !== 'boolean'
          || typeof reply.accepted !== 'boolean' || typeof reply.proof !== 'string' || !/^[a-f0-9]{64}$/.test(reply.proof))
          return finish(null)
        const expected = proof(key, [nonce, operation, reply.pid, reply.ready, reply.accepted].join('|'))
        finish(timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(reply.proof, 'hex')) ? reply : null)
      } catch { finish(null) }
    })
  })
}

export async function createConfiguration(label: string, exe: string, script: string, dependencies: string[]): Promise<NodeWorkload> {
  let executable: string
  let entry: string
  try {
    [executable, entry] = await Promise.all([realpath(exe), realpath(script)])
    const local = (path: string) => /^[A-Z]:\\/i.test(path) && isAbsolute(path)
    if (!local(executable) || !local(entry) || basename(executable).toLowerCase() !== 'node.exe'
      || !['.js', '.cjs', '.mjs'].includes(extname(entry).toLowerCase())) throw new Error('file type')
    const [exeStat, entryStat] = await Promise.all([stat(executable), stat(entry)])
    if (!exeStat.isFile() || !entryStat.isFile()) throw new Error('regular files')
  } catch {
    throw new UserError('Select a local node.exe and a JavaScript entry file.')
  }
  const [executableHash, entryHash] = await Promise.all([hash(executable), hash(entry)])
  return { id: 'node:' + randomUUID(), label, executable, entry, executableHash, entryHash, dependencies }
}

export class NodeRuntime {
  constructor(
    private readonly windows: Windows,
    private readonly store: Store,
    private readonly bootstrap: string,
    private readonly secrets: Secrets,
  ) {}

  private async key(session: NodeSession) {
    try { return await this.secrets.unseal(session.key) } catch { return null }
  }

  private owns(config: NodeWorkload, session: NodeSession, process: RawProcess) {
    const args = process.args
    return !!process.started && !!process.path && sameFile(process.path, config.executable)
      && args?.[1] === '--require' && !!args[2] && sameFile(args[2], session.bootstrap)
      && !!args[3] && sameFile(args[3], config.entry)
      && (session.pid === null || session.pid === process.pid)
  }

  async observe(configuration: NodeWorkload, processes: RawProcess[]): Promise<NodeObservation> {
    const session = this.store.session(configuration.id)
    const matches = matchingNode(processes, configuration.executable, configuration.entry)
    const fallback: NodeObservation = {
      configuration, state: 'stopped', ready: false, process: null, sessionId: session?.id ?? null,
      detail: 'Launch the approved project in Development Mode.',
    }

    if (session) {
      const candidate = matches.find(process => this.owns(configuration, session, process))
      if (candidate) {
        const key = await this.key(session)
        const response = key ? await pipe(session, key, 'ping') : null
        const ready = response?.pid === candidate.pid && response.ready
        return {
          ...fallback, state: 'running', ready, process: candidate,
          detail: ready ? 'Project shutdown is available.' : 'The project has yet to offer a verified shutdown handler.',
        }
      }

      const inaccessible = session.pid && processes.find(process => process.pid === session.pid && !process.path && /^node\.exe$/i.test(process.name))
      if (inaccessible) return {
        ...fallback, state: 'unknown', process: inaccessible,
        detail: 'Windows did not allow DevShift to verify the saved process identity.',
      }
    }

    if (matches.length) return {
      ...fallback, state: 'running', sessionId: null, process: matches[0]!, detail: 'This project was launched outside DevShift.',
    }
    return fallback
  }

  async start(configuration: NodeWorkload, scan: WindowsScan) {
    const current = await this.observe(configuration, scan.processes)
    if (current.state === 'running' && (current.ready || !this.store.session(configuration.id))) return { changed: false }
    if (current.state !== 'stopped') throw new UserError('A matching project is already running or its identity is unavailable.')
    if (configuration.dependencies.some(name => scan.services.find(service => service.name.toLowerCase() === name)?.state !== 'running'))
      throw new UserError('A declared Windows service dependency is unavailable.')

    const currentHashes = await Promise.all([hash(configuration.executable), hash(configuration.entry)])
      .catch(() => { throw new UserError('The approved Node executable or script is unavailable.') })
    if (currentHashes[0] !== configuration.executableHash || currentHashes[1] !== configuration.entryHash)
      throw new UserError('The approved Node executable or script changed. Review the files before relaunching it.')

    const key = randomBytes(32).toString('hex')
    const session: NodeSession = { id: randomUUID(), key: await this.secrets.seal(key), bootstrap: this.bootstrap, pid: null }
    this.store.saveSession(configuration.id, session)
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !/^(NODE_OPTIONS|NODE_PATH|ELECTRON_RUN_AS_NODE|NODE_CHANNEL_FD|NODE_CHANNEL_SERIALIZATION_MODE|DEVSHIFT_)/i.test(name),
    ))
    env.DEVSHIFT_CONTROL_ID = session.id
    env.DEVSHIFT_CONTROL_KEY = key
    env.DEVSHIFT_SHUTDOWN_MODULE = this.bootstrap

    const child = spawn(configuration.executable, ['--require', this.bootstrap, configuration.entry], {
      cwd: dirname(configuration.entry), env, detached: true, windowsHide: true, stdio: 'ignore',
    })
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', () => reject(new UserError('Windows could not launch the approved Node project.')))
    })
    session.pid = child.pid ?? null
    this.store.saveSession(configuration.id, session)
    child.unref()

    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && child.exitCode === null) {
      const reply = await pipe(session, key, 'ping')
      if (reply?.pid === session.pid && reply.ready) {
        const process = await this.windows.process(reply.pid)
        if (process && this.owns(configuration, session, process)) return { changed: true }
      }
      await delay(150)
    }
    throw new UserError('The project did not report readiness. Check the script and its shutdown registration.')
  }

  async stop(configuration: NodeWorkload, sessionId: string, expected: RawProcess) {
    const session = this.store.session(configuration.id)
    if (session?.id !== sessionId) throw new UserError('The approved workload launch session changed.', true)
    const process = await this.windows.process(expected.pid)
    if (!process || !sameIdentity(expected, process)) return { changed: false }
    if (!this.owns(configuration, session, process))
      throw new UserError('The saved process identity could not be verified.', true)

    const key = await this.key(session)
    const status = key ? await pipe(session, key, 'ping') : null
    if (!key || status?.pid !== process.pid || !status.ready)
      throw new UserError('The project shutdown handler is unavailable.', true)
    const result = await pipe(session, key, 'stop')
    if (result?.pid !== process.pid || !result.accepted)
      throw new UserError('The project did not confirm that its shutdown handler completed.')

    const deadline = Date.now() + 8_000
    while (Date.now() < deadline) {
      const current = await this.windows.process(expected.pid)
      if (!current || !sameIdentity(expected, current)) return { changed: true }
      await delay(200)
    }
    throw new UserError('The project accepted shutdown and is still running.')
  }
}
