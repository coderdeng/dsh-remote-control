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

import { hostname } from 'node:os'
import {
  API_PREFIX,
  PLUGIN_VERSION,
  PROTOCOL_VERSION,
  RemoteControlError,
  clamp,
  jsonPreview,
  normalizeHost,
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
    if (this.config.hosts.size === 0) {
      this.log.warn('no remote hosts configured yet; edit the remote-control config.hosts list in the profile patch to add one')
    } else {
      this.log.info(`controller ready with ${this.config.hosts.size} host(s): ${[...this.config.hosts.keys()].join(', ')}`)
    }
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
    if (this.config.hosts.size === 0) {
      throw new Error(
        '尚未配置远端电脑（no remote host configured）。请在本机 profile 的 remote-control 行 config.hosts 中添加 { name, endpoint, token }，保存后会自动重新加载。',
      )
    }
    if (typeof name !== 'string' || name.trim() === '') {
      if (this.config.hosts.size === 1) return [...this.config.hosts.values()][0]
      if (required === false) return undefined
      throw new Error(`missing "host" argument; configured hosts: ${[...this.config.hosts.keys()].join(', ')}`)
    }
    const found = this.config.hosts.get(name.trim())
    if (found === undefined) throw new Error(`unknown host ${JSON.stringify(name)}; configured hosts: ${[...this.config.hosts.keys()].join(', ')}`)
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
    const { payload } = await this.request(host, 'GET', '/hello', { timeoutMs: options.timeoutMs ?? 4000 })
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

  /** List configured remote hosts and whether each worker is reachable. */
  hostsTool() {
    return this.tool(
      'remote_dsh_hosts',
      'List the remote computers this machine can control, whether each DSH worker is reachable right now, and which model/cwd it will use. Call this first when the user refers to another computer or asks what remote machines are available.',
      {},
      async () => {
        const values = await Promise.all([...this.config.hosts.values()].map((host) => this.probe(host)))
        return { controller: { hostname: hostname(), pluginVersion: PLUGIN_VERSION, protocol: PROTOCOL_VERSION }, hosts: values }
      },
      (value) => (value.hosts.length === 0
        ? `remote DSH workers (${value.controller.hostname}): none configured yet. 在本机 profile 的 remote-control 行 config.hosts 中添加远端电脑（name/endpoint/token）后会自动生效。`
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
