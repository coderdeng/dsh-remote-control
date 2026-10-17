/**
 * Controller side of the DSH remote-control bridge.
 *
 * Mounted on the computer the user is sitting at. It registers model-facing host
 * tools that dispatch tasks to one or more remote DSH "worker" hosts over the LAN:
 * a remote task is a real DSH session on the other machine, driven with ordinary
 * user prompts, and read back through a durable transcript cursor.
 *
 * @module dsh-remote-control/controller
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import {
  API_PREFIX,
  PLUGIN_VERSION,
  PROTOCOL_VERSION,
  RemoteControlError,
  clamp,
  decodePairingCode,
  jsonPreview,
  normalizeHost,
  remoteControlStateDir,
  truncate,
} from './protocol.js'

/** Stable Cordis plugin name. */
export const name = 'remote-control-controller'

/** Services the controller cannot run without (it only contributes tools). */
export const inject = ['tools']

/** Configured role marker. */
export const role = 'controller'

/** Fire-and-forget logger that tolerates a missing logger service. */
function makeLogger(ctx) {
  const logger = (() => {
    try {
      return ctx.logger?.('remote-control')
    } catch {
      return undefined
    }
  })()
  const emit = (level, ...args) => {
    try {
      if (logger !== undefined && typeof logger[level] === 'function') logger[level](...args)
      else console.error('[remote-control]', ...args)
    } catch {
      /* logging must never break the bridge */
    }
  }
  return { info: (...args) => emit('info', ...args), warn: (...args) => emit('warn', ...args), error: (...args) => emit('error', ...args) }
}

/** One JSON Schema object with a closed property set. */
function objectSchema(properties, required = []) {
  return { type: 'object', properties, required, additionalProperties: false }
}

/** Tool parameter spec helpers. */
const string = (description) => ({ type: 'string', description })
const integer = (description) => ({ type: 'integer', description })

/**
 * Normalize the controller `config` block.
 * @param {Record<string, unknown> | undefined} raw config.
 * @returns {{
 *   hosts: Map<string, { name: string, endpoint: string, token: string, description?: string, workdir?: string }>,
 *   defaultWaitTimeoutMs: number, maxWaitTimeoutMs: number, requestTimeoutMs: number,
 *   startWaitMs: number, maxTranscriptChars: number,
 * }} resolved config.
 */
export function normalizeControllerConfig(raw) {
  const config = raw ?? {}
  const entries = Array.isArray(config.hosts) ? config.hosts : []
  const hosts = new Map()
  entries.forEach((entry, index) => {
    const host = normalizeHost(`host-${index + 1}`, entry)
    if (hosts.has(host.name)) {
      throw new RemoteControlError('config/duplicate-host', `remote-control controller: duplicate host name ${JSON.stringify(host.name)}`, 500)
    }
    hosts.set(host.name, host)
  })
  return {
    hosts,
    defaultWaitTimeoutMs: clamp(config.defaultWaitTimeoutMs, 1000, 120000, 45000),
    maxWaitTimeoutMs: clamp(config.maxWaitTimeoutMs, 1000, 300000, 120000),
    requestTimeoutMs: clamp(config.requestTimeoutMs, 1000, 120000, 30000),
    startWaitMs: clamp(config.startWaitMs, 0, 60000, 15000),
    maxTranscriptChars: clamp(config.maxTranscriptChars, 1000, 200000, 12000),
  }
}

/** Human-readable one-line connectivity summary. */
function describeHostEntry(value) {
  if (value.online !== true) return `- ${value.name}: OFFLINE (${value.endpoint}) ${value.error ? `— ${value.error}` : ''}`
  const facts = value.worker ?? {}
  const selection = value.selection?.provider ? `${value.selection.provider}/${value.selection.model}` : 'default model'
  return `- ${value.name}: online — ${value.endpoint} (${facts.hostname ?? '?'} ${facts.platform ?? ''}, cwd ${facts.cwd ?? '?'}, ${selection}, ${value.description ?? 'no description'})`
}

/** Render one started/waited session result. */
function renderSessionResult(value) {
  const head = [
    `host: ${value.host}`,
    `session: ${value.sessionId}`,
    `status: ${value.status}${value.idle === true ? ' (idle)' : value.idle === false ? ' (running)' : ''}`,
    value.cwd ? `cwd: ${value.cwd}` : undefined,
    value.title ? `title: ${value.title}` : undefined,
    value.error ? `error: ${value.error}` : undefined,
  ].filter(Boolean)
  const output = typeof value.output === 'string' && value.output.trim() !== '' ? value.output.trim() : '(no new output)'
  return `${head.join('\n')}\n\n--- transcript since previous read ---\n${output}`
}

/** Compact status rendering. */
function renderStatus(value) {
  if (value.sessions !== undefined) {
    if (value.sessions.length === 0) return `host ${value.host}: no live remote sessions`
    return [`host ${value.host}: ${value.sessions.length} live session(s)`, ...value.sessions.map((session) => `- ${session.sessionId}: ${session.status}, cwd ${session.cwd}, turns ${session.turnCount}${session.title ? `, title ${session.title}` : ''}`)].join('\n')
  }
  const session = value.session ?? value
  return [
    `host: ${value.host}`,
    `session: ${session.sessionId}`,
    `status: ${session.status}${session.idle === true ? ' (idle)' : session.idle === false ? ' (running)' : ''}`,
    `cwd: ${session.cwd}`,
    `title: ${session.title ?? '(untitled)'}`,
    `turns: ${session.turnCount}`,
    session.error ? `error: ${session.error}` : undefined,
    session.lastAssistantText ? `\nlast assistant message:\n${truncate(session.lastAssistantText, 1500)}` : undefined,
  ].filter(Boolean).join('\n')
}

/**
 * Runtime object holding configured hosts and the transcript cursors shared with
 * the model-facing tools.
 */
export class ControllerRuntime {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx scoped context providing `tools`.
   * @param {Record<string, unknown>} config raw profile config.
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = normalizeControllerConfig(config)
    /** @type {Map<string, number>} host/sessionId -> last durable seq already reported */
    this.cursors = new Map()
    this.disposers = []
    this.log = makeLogger(ctx)
    /** hosts added at runtime through `remote_dsh_pair`, persisted under the DSH home. */
    this.stateHosts = new Map()
    this.saveChain = Promise.resolve()
  }

  /** Register every remote_* tool on the calling host's tool registry. */
  register() {
    this.disposers.push(this.ctx.tools.register(this.hostsTool()))
    this.disposers.push(this.ctx.tools.register(this.startTool()))
    this.disposers.push(this.ctx.tools.register(this.waitTool()))
    this.disposers.push(this.ctx.tools.register(this.sendTool()))
    this.disposers.push(this.ctx.tools.register(this.statusTool()))
    this.disposers.push(this.ctx.tools.register(this.logTool()))
    this.disposers.push(this.ctx.tools.register(this.abortTool()))
    this.disposers.push(this.ctx.tools.register(this.pairTool()))
    this.disposers.push(this.ctx.tools.register(this.unpairTool()))
    const known = this.allHosts()
    if (known.length === 0) {
      this.log.warn('no remote hosts configured yet; pair one with remote_dsh_pair or add it to config.hosts')
    } else {
      this.log.info(`controller ready with ${known.length} host(s): ${known.map((host) => host.name).join(', ')}`)
    }
    void this.loadStateHosts()
  }

  /** Config-declared hosts first, then runtime-paired hosts (paired entries win on name). */
  allHosts() {
    const merged = new Map(this.config.hosts)
    for (const [name, host] of this.stateHosts) merged.set(name, host)
    return [...merged.values()]
  }

  /** Local state file holding hosts added by pairing. */
  stateFile() {
    return join(remoteControlStateDir(), 'hosts.json')
  }

  /** Load runtime-paired hosts from the local state file (missing file is normal). */
  async loadStateHosts() {
    let text
    try {
      text = await readFile(this.stateFile(), 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') this.log.warn(`could not read ${this.stateFile()}:`, error?.message ?? error)
      return
    }
    let document
    try {
      document = JSON.parse(text)
    } catch {
      this.log.warn(`ignoring ${this.stateFile()}: not valid JSON`)
      return
    }
    const entries = Array.isArray(document?.hosts) ? document.hosts : []
    for (const [index, entry] of entries.entries()) {
      try {
        const host = normalizeHost(`paired-${index + 1}`, entry)
        this.stateHosts.set(host.name, host)
      } catch (error) {
        this.log.warn(`ignoring paired host entry ${index}: ${error?.message ?? error}`)
      }
    }
    if (this.stateHosts.size > 0) this.log.info(`loaded ${this.stateHosts.size} paired host(s) from ${this.stateFile()}`)
  }

  /** Persist runtime-paired hosts; writes are serialized to avoid lost updates. */
  persistStateHosts() {
    const document = {
      schemaVersion: 1,
      hosts: [...this.stateHosts.values()].map((host) => ({
        name: host.name,
        endpoint: host.endpoint,
        token: host.token,
        ...(host.description === undefined ? {} : { description: host.description }),
        ...(host.workdir === undefined ? {} : { workdir: host.workdir }),
      })),
    }
    const file = this.stateFile()
    const write = this.saveChain.then(async () => {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 })
      await chmod(file, 0o600).catch(() => {})
    })
    this.saveChain = write.catch(() => {})
    return write
  }

  /** Dispose every registered tool. */
  close() {
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose()
      } catch (error) {
        this.log.warn('failed to unregister tool:', error)
      }
    }
  }

  // -------------------------------------------------------------------------
  // HTTP client
  // -------------------------------------------------------------------------

  /** Resolve a configured host, allowing omission when exactly one is configured. */
  host(name, required = true) {
    const hosts = this.allHosts()
    if (hosts.length === 0) {
      throw new Error(
        '尚未配置远端电脑（no remote host configured）。可以让用户提供 worker 启动时打印的配对码，然后调用 remote_dsh_pair 自动添加（无需改配置）。',
      )
    }
    if (typeof name !== 'string' || name.trim() === '') {
      if (hosts.length === 1) return hosts[0]
      if (required === false) return undefined
      throw new Error(`missing "host" argument; known hosts: ${hosts.map((host) => host.name).join(', ')}`)
    }
    const found = hosts.find((host) => host.name === name.trim())
    if (found === undefined) throw new Error(`unknown host ${JSON.stringify(name)}; known hosts: ${hosts.map((host) => host.name).join(', ')}`)
    return found
  }

  /** Perform one authenticated JSON request against a worker. */
  async request(host, method, path, options = {}) {
    const url = new URL(`${host.endpoint}${API_PREFIX}${path}`)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
    }
    const timeoutMs = options.timeoutMs ?? this.config.requestTimeoutMs
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs} ms`)), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    const signals = [controller.signal]
    if (options.signal !== undefined) signals.push(options.signal)
    let response
    try {
      response = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${host.token}`,
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.any(signals),
      })
    } catch (error) {
      throw new Error(`cannot reach remote host ${host.name} at ${host.endpoint}: ${error?.cause?.code ?? error?.message ?? error}`)
    } finally {
      clearTimeout(timer)
    }
    const text = await response.text()
    let payload
    try {
      payload = text === '' ? {} : JSON.parse(text)
    } catch {
      throw new Error(`remote host ${host.name} returned a non-JSON response (HTTP ${response.status})`)
    }
    if (response.ok !== true || payload?.ok === false) {
      const code = payload?.error?.code ?? `http/${response.status}`
      const message = payload?.error?.message ?? JSON.stringify(payload).slice(0, 500)
      throw new Error(`remote host ${host.name}: ${code}: ${message}`)
    }
    return { payload, protocol: payload?.protocol }
  }

  /** Verify the worker protocol version on first contact. */
  async hello(host, options = {}) {
    const { payload } = await this.request(host, 'GET', '/hello', { timeoutMs: options.timeoutMs ?? 4000, ...(options.signal === undefined ? {} : { signal: options.signal }) })
    if (payload.protocol !== PROTOCOL_VERSION) {
      throw new Error(`remote host ${host.name} speaks protocol ${payload.protocol}, this controller speaks ${PROTOCOL_VERSION}; update both sides`)
    }
    return payload
  }

  /** A pinging hello without throwing, for the hosts listing. */
  async probe(host) {
    try {
      const payload = await this.hello(host)
      return { name: host.name, endpoint: host.endpoint, description: host.description, online: true, ...payload }
    } catch (error) {
      return { name: host.name, endpoint: host.endpoint, description: host.description, online: false, error: truncate(error?.message ?? String(error), 400) }
    }
  }

  // -------------------------------------------------------------------------
  // cursors
  // -------------------------------------------------------------------------

  /** Read the durable transcript cursor for one remote session. */
  cursorFor(hostName, sessionId) {
    return this.cursors.get(`${hostName}/${sessionId}`) ?? 0
  }

  /** Advance the cursor, never moving it backwards. */
  advanceCursor(hostName, sessionId, nextSeq) {
    if (typeof nextSeq !== 'number' || !Number.isFinite(nextSeq)) return
    const key = `${hostName}/${sessionId}`
    const previous = this.cursors.get(key) ?? 0
    this.cursors.set(key, Math.max(previous, nextSeq))
  }

  // -------------------------------------------------------------------------
  // tools
  // -------------------------------------------------------------------------

  /** A tool definition factory shared by every remote tool. */
  tool(name, description, parameters, execute, render, outputSchema) {
    return {
      name,
      description,
      parameters: objectSchema(parameters),
      output: { schema: outputSchema ?? { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: render(value) }] },
      execute,
    }
  }

  /** List configured or paired remote hosts and whether each worker is reachable. */
  hostsTool() {
    return this.tool(
      'remote_dsh_hosts',
      'List the remote computers this machine can control, whether each DSH worker is reachable right now, and which model/cwd it will use. Call this first when the user refers to another computer or asks what remote machines are available. When nothing is configured, ask the user for the pairing code printed by the worker (starts with "dshrc1.") and call remote_dsh_pair.',
      {},
      async () => {
        const values = await Promise.all(this.allHosts().map((host) => this.probe(host)))
        return { controller: { hostname: hostname(), pluginVersion: PLUGIN_VERSION, protocol: PROTOCOL_VERSION }, hosts: values }
      },
      (value) => (value.hosts.length === 0
        ? `remote DSH workers (${value.controller.hostname}): none configured yet. 把远端 worker 启动时打印的配对码（dshrc1. 开头）发给 agent，用 remote_dsh_pair 自动添加，无需改配置。`
        : [`remote DSH workers (${value.controller.hostname}):`, ...value.hosts.map(describeHostEntry)].join('\n')),
      objectSchema({
        controller: objectSchema({
          hostname: string('Controller host name.'),
          pluginVersion: string('Plugin version.'),
          protocol: integer('Wire protocol version.'),
        }, ['hostname', 'pluginVersion', 'protocol']),
        hosts: { type: 'array', items: { type: 'object', additionalProperties: true } },
      }, ['controller', 'hosts']),
    )
  }

  /** Add or update a remote host from a pairing code (or endpoint + token). */
  pairTool() {
    return this.tool(
      'remote_dsh_pair',
      'Pair a remote computer: verify its DSH worker and save it persistently, so it can be controlled with remote_dsh_start. Pass the pairing code printed by the worker at startup (starts with "dshrc1."), or pass endpoint and token separately. The pairing code contains the shared token — treat it as a secret. Use this whenever the user sends a pairing code or wants to add another computer, instead of asking them to edit config files.',
      {
        code: string('The pairing code printed by the worker, starting with "dshrc1." (contains endpoint + token).'),
        endpoint: string('Alternatively: worker endpoint such as http://192.168.1.20:7801.'),
        token: string('Alternatively: the shared token configured on the worker.'),
        name: string('Display name for the host (defaults to the worker hostname).'),
        description: string('Optional description shown in remote_dsh_hosts.'),
      },
      async (args, exec) => {
        let host
        if (typeof args.code === 'string' && args.code.trim() !== '') {
          host = decodePairingCode(args.code.trim())
        } else if (typeof args.endpoint === 'string' && typeof args.token === 'string') {
          host = normalizeHost(typeof args.name === 'string' && args.name.length > 0 ? args.name : 'remote', {
            name: args.name,
            endpoint: args.endpoint,
            token: args.token,
            description: args.description,
          })
        } else {
          throw new Error('pairing needs either a "code" (dshrc1.…) or both "endpoint" and "token"')
        }
        if (typeof args.description === 'string' && args.description.length > 0) host.description = args.description
        const hello = await this.hello(host, { signal: exec.signal, timeoutMs: 6000 })
        const existing = this.allHosts().some((entry) => entry.name === host.name)
        this.stateHosts.set(host.name, host)
        await this.persistStateHosts()
        return {
          paired: true,
          updated: existing,
          host: host.name,
          endpoint: host.endpoint,
          worker: hello.worker,
          selection: hello.selection,
          permissionPreset: hello.permissionPreset,
        }
      },
      (value) => [
        `${value.updated ? 'updated' : 'paired'} remote host: ${value.host}`,
        `endpoint: ${value.endpoint}`,
        `worker: ${value.worker?.hostname ?? '?'} ${value.worker?.platform ?? ''}/${value.worker?.arch ?? ''}`,
        `model: ${value.selection?.provider ?? '?'}/${value.selection?.model ?? '?'}`,
        `permission: ${value.permissionPreset ?? '(host default)'}`,
        '现在可以直接用 remote_dsh_start 在这个远端上执行任务。',
      ].join('\n'),
      objectSchema({
        paired: { type: 'boolean', description: 'Whether the host is paired.' },
        updated: { type: 'boolean', description: 'True when an existing host entry was replaced.' },
        host: string('Host name used by the other tools.'),
        endpoint: string('Worker endpoint.'),
        worker: { type: 'object', additionalProperties: true, description: 'Worker facts from /v1/hello.' },
        selection: { type: 'object', additionalProperties: true, description: 'Remote model route.' },
        permissionPreset: string('Permission preset pinned for remote sessions.'),
      }, ['paired', 'updated', 'host', 'endpoint']),
    )
  }

  /** Remove a host that was added by pairing. */
  unpairTool() {
    return this.tool(
      'remote_dsh_unpair',
      'Forget a remote computer that was added with remote_dsh_pair (runtime-paired hosts only; hosts declared in the profile config must be removed from config).',
      { name: string('Host name to remove.') },
      async (args) => {
        const name = typeof args.name === 'string' ? args.name.trim() : ''
        if (name === '') throw new Error('unpair needs the host name')
        if (!this.stateHosts.has(name)) {
          if (this.config.hosts.has(name)) throw new Error(`host ${JSON.stringify(name)} is declared in the profile config and cannot be unpaired at runtime; remove it from config.hosts instead`)
          throw new Error(`unknown host ${JSON.stringify(name)}; known hosts: ${this.allHosts().map((host) => host.name).join(', ')}`)
        }
        this.stateHosts.delete(name)
        await this.persistStateHosts()
        return { removed: name, remaining: this.allHosts().map((host) => host.name) }
      },
      (value) => `removed paired host ${value.removed}\nremaining hosts: ${value.remaining.join(', ') || '(none)'}`,
      objectSchema({
        removed: string('Removed host name.'),
        remaining: { type: 'array', items: { type: 'string' }, description: 'Hosts still available.' },
      }, ['removed', 'remaining']),
    )
  }

  /** Start a session on a remote host and enqueue the first prompt. */
  startTool() {
    return this.tool(
      'remote_dsh_start',
      'Start a DSH agent session on a remote computer and enqueue a task prompt for it. The remote host is a different machine: it has its own working directory, files, tools and permissions — write prompts that are self-contained. Returns a sessionId; then call remote_dsh_wait with that sessionId until it reports idle, and report the transcript to the user.',
      {
        host: string('Configured remote host name (may be omitted when only one host is configured).'),
        prompt: string('The complete task or question for the remote agent, in the user\'s language. Include all context a fresh session needs.'),
        workdir: string('Absolute working directory on the remote computer. Defaults to the worker\'s configured workspaceRoot or its process directory.'),
        waitMs: integer('How long to wait for initial progress before returning, in ms (0-60000, default 15000).'),
        resumeSessionId: string('Optional: resume a previously created remote session of this host instead of starting a new one (use after a worker restart; the session history is preserved).'),
      },
      async (args, exec) => {
        const host = this.host(args.host)
        const waitMs = clamp(args.waitMs, 0, 60000, this.config.startWaitMs)
        let created
        if (typeof args.resumeSessionId === 'string' && args.resumeSessionId.length > 0) {
          created = await this.request(host, 'POST', '/sessions/resume', { body: { sessionId: args.resumeSessionId }, signal: exec.signal })
        } else {
          created = await this.request(host, 'POST', '/sessions', { body: { cwd: args.workdir }, signal: exec.signal })
        }
        const { sessionId, cwd, provider, model } = created.payload
        await this.request(host, 'POST', `/sessions/${encodeURIComponent(sessionId)}/prompt`, { body: { text: args.prompt }, signal: exec.signal })
        const waited = await this.request(host, 'GET', `/sessions/${encodeURIComponent(sessionId)}/wait`, {
          query: { timeoutMs: waitMs, afterSeq: this.cursorFor(host.name, sessionId) },
          timeoutMs: waitMs + this.config.requestTimeoutMs,
          signal: exec.signal,
        })
        const result = waited.payload
        this.advanceCursor(host.name, sessionId, result.nextSeq)
        return {
          host: host.name,
          sessionId,
          cwd,
          provider,
          model,
          status: result.status,
          idle: result.idle,
          output: result.text,
          nextSeq: result.nextSeq,
        }
      },
      renderSessionResult,
      objectSchema({
        host: string('Remote host name.'),
        sessionId: string('Remote session identity to use with remote_dsh_wait / remote_dsh_send.'),
        cwd: string('Working directory of the remote session.'),
        provider: string('Model provider on the remote host.'),
        model: string('Model id on the remote host.'),
        status: string('Remote agent status.'),
        idle: { type: 'boolean', description: 'Whether the remote agent is fully idle.' },
        output: string('Transcript produced since the previous read.'),
        nextSeq: integer('Durable transcript cursor after this read.'),
      }, ['host', 'sessionId', 'status', 'output', 'nextSeq']),
    )
  }

  /** Long-poll a remote session until idle or timeout, returning new transcript. */
  waitTool() {
    return this.tool(
      'remote_dsh_wait',
      'Wait for a remote DSH session to finish its current work (or until the timeout), then return the transcript written since the last read. Call it repeatedly while it reports "running" until it reports "idle"; then present the final result to the user. Prefer this over polling status.',
      {
        host: string('Configured remote host name (may be omitted when only one host is configured).'),
        sessionId: string('The remote sessionId returned by remote_dsh_start.'),
        timeoutMs: integer('Maximum wait in ms (1000-120000, default 45000).'),
      },
      async (args, exec) => {
        const host = this.host(args.host)
        const timeoutMs = clamp(args.timeoutMs, 1000, this.config.maxWaitTimeoutMs, this.config.defaultWaitTimeoutMs)
        const waited = await this.request(host, 'GET', `/sessions/${encodeURIComponent(args.sessionId)}/wait`, {
          query: { timeoutMs, afterSeq: this.cursorFor(host.name, args.sessionId) },
          timeoutMs: timeoutMs + this.config.requestTimeoutMs,
          signal: exec.signal,
        })
        const result = waited.payload
        this.advanceCursor(host.name, args.sessionId, result.nextSeq)
        return {
          host: host.name,
          sessionId: args.sessionId,
          status: result.status,
          idle: result.idle,
          title: result.title,
          error: result.error,
          output: result.text,
          nextSeq: result.nextSeq,
        }
      },
      renderSessionResult,
      objectSchema({
        host: string('Remote host name.'),
        sessionId: string('Remote session identity.'),
        status: string('Remote agent status.'),
        idle: { type: 'boolean', description: 'Whether the remote agent is fully idle.' },
        title: string('Session title, when the remote host has generated one.'),
        error: string('Last agent error on the remote session, when present.'),
        output: string('Transcript produced since the previous read.'),
        nextSeq: integer('Durable transcript cursor after this read.'),
      }, ['host', 'sessionId', 'status', 'output', 'nextSeq']),
    )
  }

  /** Send a follow-up prompt into an existing remote session. */
  sendTool() {
    return this.tool(
      'remote_dsh_send',
      'Send a follow-up message to an existing remote DSH session (for example to answer its question or refine its task). The remote session keeps its history and working directory. After sending, call remote_dsh_wait to read the reply.',
      {
        host: string('Configured remote host name (may be omitted when only one host is configured).'),
        sessionId: string('The remote sessionId.'),
        text: string('The follow-up message text.'),
      },
      async (args, exec) => {
        const host = this.host(args.host)
        const sent = await this.request(host, 'POST', `/sessions/${encodeURIComponent(args.sessionId)}/prompt`, { body: { text: args.text }, signal: exec.signal })
        return { host: host.name, sessionId: args.sessionId, messageId: sent.payload.messageId, status: sent.payload.status }
      },
      (value) => `host: ${value.host}\nsession: ${value.sessionId}\nfollow-up enqueued (message ${value.messageId}), remote status: ${value.status}`,
      objectSchema({
        host: string('Remote host name.'),
        sessionId: string('Remote session identity.'),
        messageId: string('Durable message id assigned by the remote host.'),
        status: string('Remote agent status right after enqueueing.'),
      }, ['host', 'sessionId', 'messageId', 'status']),
    )
  }

  /** Session status, or the list of live sessions on a host. */
  statusTool() {
    return this.tool(
      'remote_dsh_status',
      'Show one remote DSH session\'s status (cwd, turns, last assistant message, errors) or, when sessionId is omitted, list every live session on that remote host. Use it to inspect state without waiting.',
      {
        host: string('Configured remote host name (may be omitted when only one host is configured).'),
        sessionId: string('Optional remote sessionId; omit to list all live sessions on the host.'),
      },
      async (args, exec) => {
        const host = this.host(args.host)
        if (typeof args.sessionId === 'string' && args.sessionId.length > 0) {
          const status = await this.request(host, 'GET', `/sessions/${encodeURIComponent(args.sessionId)}`, { signal: exec.signal })
          return { host: host.name, session: status.payload.session }
        }
        const sessions = await this.request(host, 'GET', '/sessions', { signal: exec.signal })
        return { host: host.name, sessions: sessions.payload.sessions }
      },
      renderStatus,
      objectSchema({
        host: string('Remote host name.'),
        session: { type: 'object', additionalProperties: true, description: 'One session status, when a sessionId was given.' },
        sessions: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Live sessions, when sessionId was omitted.' },
      }, ['host']),
    )
  }

  /** Read transcript history from a remote session without waiting. */
  logTool() {
    return this.tool(
      'remote_dsh_log',
      'Read the recent transcript of a remote DSH session without waiting for it. Use after remote_dsh_start when you need intermediate detail that a long wait may have summarized, or to re-read earlier output.',
      {
        host: string('Configured remote host name (may be omitted when only one host is configured).'),
        sessionId: string('The remote sessionId.'),
        afterSeq: integer('Durable sequence cursor to read after; defaults to the controller\'s own last-read position.'),
        limit: integer('Maximum transcript items to return (1-400).'),
      },
      async (args, exec) => {
        const host = this.host(args.host)
        const afterSeq = typeof args.afterSeq === 'number' ? args.afterSeq : this.cursorFor(host.name, args.sessionId)
        const read = await this.request(host, 'GET', `/sessions/${encodeURIComponent(args.sessionId)}/events`, {
          query: { afterSeq, limit: clamp(args.limit, 1, 400, 200), maxChars: this.config.maxTranscriptChars },
          signal: exec.signal,
        })
        const result = read.payload
        this.advanceCursor(host.name, args.sessionId, result.nextSeq)
        return { host: host.name, sessionId: args.sessionId, status: result.status, title: result.title, lastAssistantText: result.lastAssistantText, output: result.text, nextSeq: result.nextSeq, count: result.count }
      },
      (value) => renderSessionResult(value),
      objectSchema({
        host: string('Remote host name.'),
        sessionId: string('Remote session identity.'),
        status: string('Remote agent status.'),
        title: string('Session title, when known.'),
        lastAssistantText: string('Latest assistant message on the remote session.'),
        output: string('Transcript produced since the requested cursor.'),
        nextSeq: integer('Durable transcript cursor after this read.'),
        count: integer('Number of transcript items returned.'),
      }, ['host', 'sessionId', 'status', 'output', 'nextSeq']),
    )
  }

  /** Cancel the remote session's current turn. */
  abortTool() {
    return this.tool(
      'remote_dsh_abort',
      'Stop the current turn of a remote DSH session (for example when the user asks to cancel a long remote task). The session stays alive with its history; queued input is discarded.',
      {
        host: string('Configured remote host name (may be omitted when only one host is configured).'),
        sessionId: string('The remote sessionId to stop.'),
      },
      async (args, exec) => {
        const host = this.host(args.host)
        const aborted = await this.request(host, 'POST', `/sessions/${encodeURIComponent(args.sessionId)}/abort`, { signal: exec.signal })
        return { host: host.name, sessionId: args.sessionId, aborted: aborted.payload.aborted, status: aborted.payload.status }
      },
      (value) => `host: ${value.host}\nsession: ${value.sessionId}\naborted: ${value.aborted}\nstatus: ${value.status}`,
      objectSchema({
        host: string('Remote host name.'),
        sessionId: string('Remote session identity.'),
        aborted: { type: 'boolean', description: 'Whether the cancel request was accepted.' },
        status: string('Remote agent status right after the cancel.'),
      }, ['host', 'sessionId', 'aborted', 'status']),
    )
  }
}

/**
 * Cordis plugin entry: register the remote_* tools for this profile.
 * @param {import('@deepseek-ai/cordis').Context} ctx context providing `tools`.
 * @param {Record<string, unknown>} config profile row config.
 */
export function apply(ctx, config) {
  const runtime = new ControllerRuntime(ctx, config)
  ctx.effect(() => {
    runtime.register()
    return () => runtime.close()
  }, 'remote-control.controller')
}

/** Exported for tests and diagnostics. */
export { jsonPreview, renderSessionResult, renderStatus }
