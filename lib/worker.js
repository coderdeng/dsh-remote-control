/**
 * Worker side of the DSH remote-control bridge.
 *
 * Mounted on the computer that should be controlled. It serves a small HTTP/JSON
 * API over the LAN, and drives real DeepSeek Harness agents on this host: every
 * remote "session" here is an ordinary DSH session (persisted, listed in the
 * host's own session store, using the host's model, tools, sandbox and skills).
 *
 * The worker never reaches into DSH internals beyond documented Cordis services:
 * `ctx.agents` (create/resume/dispose + followup/cancel/whenIdle), `ctx.on`
 * lifecycle events, and optionally `ctx.llm` / `ctx.agentDefaultModel` /
 * `ctx.subagents`.
 *
 * @module dsh-remote-control/worker
 */

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { isAbsolute, relative, resolve } from 'node:path'
import { stat } from 'node:fs/promises'
import { hostname, platform, arch } from 'node:os'
import {
  API_PREFIX,
  DEFAULT_LISTEN_HOST,
  DEFAULT_PORT,
  PLUGIN_VERSION,
  PROTOCOL_VERSION,
  RemoteControlError,
  SessionTranscript,
  clamp,
  intParam,
  readJsonBody,
  sendJson,
  tokenMatches,
  tokenOf,
} from './protocol.js'

/** Stable Cordis plugin name. */
export const name = 'remote-control-worker'

/** Services the worker cannot run without. */
export const inject = ['agents']

/** Configured role marker, so a single config shape can be validated centrally. */
export const role = 'worker'

/** Deep-freeze a structured-cloned value, matching how DSH freezes inbound messages. */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return value
}

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
  return {
    info: (...args) => emit('info', ...args),
    warn: (...args) => emit('warn', ...args),
    error: (...args) => emit('error', ...args),
  }
}

/**
 * Normalize the worker `config` block of a profile patch.
 * @param {Record<string, unknown> | undefined} raw config.
 * @returns {{
 *   token: string, listenHost: string, port: number, workspaceRoot: string | undefined,
 *   provider: string | undefined, model: string | undefined, reasoningEffort: string | undefined,
 *   maxTokens: number | undefined, maxSessions: number, maxEntries: number,
 *   maxTranscriptChars: number, maxToolResultChars: number, logRequests: boolean,
 * }} resolved config.
 */
export function normalizeWorkerConfig(raw) {
  const config = raw ?? {}
  const token = typeof config.token === 'string' ? config.token.trim() : ''
  if (token.length === 0) {
    throw new RemoteControlError(
      'config/token-required',
      'remote-control worker: config.token is required. The controller must present the same token. Generate one long random string and put it in both profile patches.',
      500,
    )
  }
  if (token.length < 16) {
    throw new RemoteControlError('config/token-too-short', 'remote-control worker: config.token must be at least 16 characters', 500)
  }
  const workspaceRootRaw = typeof config.workspaceRoot === 'string' && config.workspaceRoot.trim() !== '' ? config.workspaceRoot.trim() : undefined
  const workspaceRoot = workspaceRootRaw === undefined ? undefined : resolve(workspaceRootRaw)
  return {
    token,
    listenHost: typeof config.listenHost === 'string' && config.listenHost.trim() !== '' ? config.listenHost.trim() : DEFAULT_LISTEN_HOST,
    port: clamp(config.port, 1, 65535, DEFAULT_PORT),
    workspaceRoot,
    provider: typeof config.provider === 'string' && config.provider.length > 0 ? config.provider : undefined,
    model: typeof config.model === 'string' && config.model.length > 0 ? config.model : undefined,
    reasoningEffort: typeof config.reasoningEffort === 'string' && config.reasoningEffort.length > 0 ? config.reasoningEffort : undefined,
    maxTokens: clamp(config.maxTokens, 1, Number.MAX_SAFE_INTEGER, undefined),
    maxSessions: clamp(config.maxSessions, 1, 64, 8),
    maxEntries: clamp(config.maxEntries, 100, 20000, 4000),
    maxTranscriptChars: clamp(config.maxTranscriptChars, 2000, 200000, 12000),
    maxToolResultChars: clamp(config.maxToolResultChars, 100, 20000, 900),
    logRequests: config.logRequests === true,
    permissionPreset: typeof config.permissionPreset === 'string' && config.permissionPreset.trim() !== ''
      ? config.permissionPreset.trim()
      : config.permissionPreset === null
        ? undefined
        : 'danger-full-access',
  }
}

/**
 * Runtime object holding the HTTP server and the sessions it created.
 */
export class WorkerRuntime {
  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx scoped context providing `agents`.
   * @param {Record<string, unknown>} config raw profile config.
   */
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = normalizeWorkerConfig(config)
    this.sessions = new Map()
    this.server = undefined
    this.closed = false
    this.log = makeLogger(ctx)
    this.startedAt = Date.now()
    this.disposers = []
  }

  /** Register session-event subscriptions and start listening. */
  open() {
    if (this.server !== undefined) return
    this.disposers.push(this.ctx.on('session/event', (session, event) => {
      const record = this.sessions.get(String(session?.id))
      if (record === undefined) return
      try {
        record.transcript.append(event)
        record.lastActivityAt = Date.now()
      } catch (error) {
        this.log.warn('failed to record session event:', error)
      }
    }))
    this.disposers.push(this.ctx.on('agent/error', ({ agent, error } = {}) => {
      for (const record of this.sessions.values()) {
        if (record.handle?.agent !== agent) continue
        record.transcript.appendError(`agent error: ${error?.message ?? String(error)}`)
        record.lastActivityAt = Date.now()
      }
    }))
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((error) => {
        this.log.error('request failed:', error)
        try {
          sendJson(res, error instanceof RemoteControlError ? error.status : 500, {
            ok: false,
            error: { code: error instanceof RemoteControlError ? error.code : 'internal', message: error?.message ?? String(error) },
          })
        } catch {
          /* response already settled */
        }
      })
    })
    this.server.on('error', (error) => {
      this.log.error(`worker HTTP server error on ${this.config.listenHost}:${this.config.port}:`, error?.message ?? error)
    })
    this.server.listen(this.config.port, this.config.listenHost, () => {
      this.log.info(`worker listening on http://${this.config.listenHost}:${this.config.port} (workspaceRoot=${this.config.workspaceRoot ?? process.cwd()})`)
    })
  }

  /** Stop listening and dispose every session this worker created. */
  async close() {
    if (this.closed) return
    this.closed = true
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose()
      } catch (error) {
        this.log.warn('failed to remove listener:', error)
      }
    }
    if (this.server !== undefined) {
      const server = this.server
      this.server = undefined
      await new Promise((resolveClose) => {
        server.close(() => resolveClose())
        // Do not wait forever on keep-alive connections.
        setTimeout(resolveClose, 2000).unref?.()
      })
    }
    const records = [...this.sessions.values()]
    this.sessions.clear()
    for (const record of records) {
      try {
        await record.handle.dispose()
      } catch (error) {
        this.log.warn(`failed to dispose session ${record.sessionId}:`, error)
      }
    }
  }

  // -------------------------------------------------------------------------
  // HTTP surface
  // -------------------------------------------------------------------------

  /** Route one request; always answers exactly once. */
  async handle(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    if (this.config.logRequests) this.log.info(`${req.method} ${url.pathname}`)
    if (!tokenMatches(tokenOf(req, url), this.config.token)) {
      sendJson(res, 401, { ok: false, error: { code: 'auth/denied', message: 'invalid or missing bearer token' } })
      return
    }
    const path = url.pathname.replace(/\/+$/u, '') === '' ? '/' : url.pathname.replace(/\/+$/u, '')
    const method = req.method ?? 'GET'

    if (method === 'GET' && path === `${API_PREFIX}/health`) {
      sendJson(res, 200, { ok: true, protocol: PROTOCOL_VERSION, version: PLUGIN_VERSION, uptimeMs: Date.now() - this.startedAt })
      return
    }
    if (method === 'GET' && path === `${API_PREFIX}/hello`) {
      sendJson(res, 200, this.hello())
      return
    }
    if (method === 'GET' && path === `${API_PREFIX}/sessions`) {
      sendJson(res, 200, { ok: true, sessions: this.listSessions() })
      return
    }
    if (method === 'POST' && path === `${API_PREFIX}/sessions`) {
      const body = await readJsonBody(req)
      const created = await this.createSession(body)
      sendJson(res, 200, { ok: true, ...created })
      return
    }
    if (method === 'POST' && path === `${API_PREFIX}/sessions/resume`) {
      const body = await readJsonBody(req)
      const resumed = await this.resumeSession(body)
      sendJson(res, 200, { ok: true, ...resumed })
      return
    }

    const match = /^\/v1\/sessions\/([^/]+)(?:\/(prompt|wait|abort|close|events|status))?$/u.exec(path)
    if (match !== null) {
      const sessionId = decodeURIComponent(match[1])
      const action = match[2]
      if (method === 'GET' && action === undefined) {
        sendJson(res, 200, { ok: true, session: this.sessionStatus(sessionId) })
        return
      }
      if (method === 'GET' && action === 'status') {
        sendJson(res, 200, { ok: true, session: this.sessionStatus(sessionId) })
        return
      }
      if (method === 'GET' && action === 'events') {
        const afterSeq = intParam(url.searchParams.get('afterSeq'), 0)
        sendJson(res, 200, { ok: true, ...this.readEvents(sessionId, afterSeq, url) })
        return
      }
      if (method === 'GET' && action === 'wait') {
        const timeoutMs = clamp(url.searchParams.get('timeoutMs'), 0, 120000, 30000)
        const afterSeq = intParam(url.searchParams.get('afterSeq'), 0)
        const result = await this.waitSession(sessionId, { afterSeq, timeoutMs, signal: this.closeSignal(res) })
        if (result.outcome === 'aborted') {
          res.destroy()
          return
        }
        sendJson(res, 200, { ok: true, ...result })
        return
      }
      if (method === 'POST' && action === 'prompt') {
        const body = await readJsonBody(req)
        sendJson(res, 200, { ok: true, ...(await this.promptSession(sessionId, body)) })
        return
      }
      if (method === 'POST' && action === 'abort') {
        sendJson(res, 200, { ok: true, ...(await this.abortSession(sessionId)) })
        return
      }
      if (method === 'POST' && action === 'close') {
        sendJson(res, 200, { ok: true, ...(await this.closeSession(sessionId)) })
        return
      }
      throw new RemoteControlError('request/unsupported', `unsupported session action ${String(action)} for ${method}`, 405)
    }

    throw new RemoteControlError('request/not-found', `no route for ${method} ${path}`, 404)
  }

  /** Abort the long-poll when the controller disconnects. */
  closeSignal(res) {
    const controller = new AbortController()
    res.on('close', () => controller.abort())
    return controller.signal
  }

  /** Worker facts for the controller's `remote_dsh_hosts`. */
  hello() {
    const providers = []
    try {
      const llm = this.ctx.get('llm')
      for (const entry of llm?.listProviders?.() ?? []) {
        if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string') continue
        const models = Array.isArray(entry.models)
          ? entry.models.map((model) => (typeof model === 'string' ? model : model?.id)).filter((id) => typeof id === 'string').slice(0, 40)
          : undefined
        providers.push({ id: entry.id, ...(models === undefined ? {} : { models }) })
      }
    } catch {
      /* provider discovery is informational only */
    }
    let defaultSelection
    try {
      defaultSelection = this.ctx.get('agentDefaultModel')?.currentSelection?.()
    } catch {
      defaultSelection = undefined
    }
    return {
      ok: true,
      protocol: PROTOCOL_VERSION,
      version: PLUGIN_VERSION,
      worker: {
        hostname: hostname(),
        platform: platform(),
        arch: arch(),
        pid: process.pid,
        cwd: process.cwd(),
        workspaceRoot: this.config.workspaceRoot,
        startedAt: new Date(this.startedAt).toISOString(),
      },
      selection: {
        provider: this.config.provider ?? defaultSelection?.provider,
        model: this.config.model ?? defaultSelection?.model,
        reasoningEffort: this.config.reasoningEffort ?? defaultSelection?.reasoningEffort,
      },
      permissionPreset: this.config.permissionPreset,
      providers,
      capabilities: ['sessions', 'prompt', 'wait', 'events', 'abort', 'close'],
      sessions: this.listSessions().length,
    }
  }

  /** Current model route used by new sessions. */
  agentOptions(overrides = {}) {
    const selection = (() => {
      try {
        return this.ctx.get('agentDefaultModel')?.currentSelection?.()
      } catch {
        return undefined
      }
    })()
    const provider = overrides.provider ?? this.config.provider ?? selection?.provider
    const model = overrides.model ?? this.config.model ?? selection?.model
    if (typeof provider !== 'string' || provider.length === 0 || typeof model !== 'string' || model.length === 0) {
      throw new RemoteControlError(
        'session/no-model',
        'remote-control worker: no provider/model configured. Set config.provider and config.model in the worker profile patch (or configure an agent default model on the remote host).',
        500,
      )
    }
    const reasoningEffort = overrides.reasoningEffort ?? this.config.reasoningEffort
    const maxTokens = clamp(overrides.maxTokens ?? this.config.maxTokens, 1, Number.MAX_SAFE_INTEGER, undefined)
    return {
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    }
  }

  /** Validate one requested working directory against the configured workspace root. */
  resolveCwd(requested) {
    const base = resolve(requested ?? this.config.workspaceRoot ?? process.cwd())
    if (this.config.workspaceRoot !== undefined) {
      const rel = relative(this.config.workspaceRoot, base)
      if (rel !== '' && (rel.startsWith('..') || isAbsolute(rel))) {
        throw new RemoteControlError('session/cwd-outside-workspace', `requested working directory ${base} is outside the configured workspaceRoot ${this.config.workspaceRoot}`, 403)
      }
    }
    return base
  }

  /** Create one DSH agent session and return its identity. */
  async createSession(params = {}) {
    if (this.sessions.size >= this.config.maxSessions) {
      throw new RemoteControlError('session/limit', `too many live sessions on the worker (max ${this.config.maxSessions}); close one first`, 429)
    }
    const cwd = this.resolveCwd(typeof params.cwd === 'string' && params.cwd.length > 0 ? params.cwd : undefined)
    try {
      const info = await stat(cwd)
      if (!info.isDirectory()) throw new Error('not a directory')
    } catch {
      throw new RemoteControlError('session/bad-cwd', `working directory does not exist on the worker: ${cwd}`, 400)
    }
    const agentOptions = this.agentOptions({
      provider: params.provider,
      model: params.model,
      reasoningEffort: params.reasoningEffort,
      maxTokens: params.maxTokens,
    })
    try {
      const llm = this.ctx.get('llm')
      await llm?.resolveCallConfig?.(agentOptions)
    } catch (error) {
      throw new RemoteControlError('session/model-unavailable', `model route ${agentOptions.provider}/${agentOptions.model} is unavailable on the worker: ${error?.message ?? error}`, 400)
    }
    const sessionId = `session-${randomUUID()}`
    let handle
    try {
      handle = await this.ctx.agents.create({
        sessionId,
        meta: { cwd },
        agentOptions,
      })
    } catch (error) {
      throw new RemoteControlError('session/create-failed', `failed to create a remote session: ${error?.message ?? error}`, 500)
    }
    const record = {
      sessionId,
      cwd,
      agentOptions,
      handle,
      transcript: new SessionTranscript({ maxEntries: this.config.maxEntries, maxToolResultChars: this.config.maxToolResultChars }),
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    }
    this.applyPermissionPreset(record)
    this.sessions.set(sessionId, record)
    this.log.info(`created session ${sessionId} (cwd=${cwd}, ${agentOptions.provider}/${agentOptions.model})`)
    return { sessionId, cwd, provider: agentOptions.provider, model: agentOptions.model }
  }

  /** Resolve one live session or fail with a stable error. */
  requireSession(sessionId) {
    const record = this.sessions.get(sessionId)
    if (record === undefined) throw new RemoteControlError('session/not-found', `no live session ${sessionId} on this worker; it may have been closed or this worker restarted`, 404)
    return record
  }

  /**
   * Resume a persisted session from the worker host's session store.
   * Lets the controller recover remote sessions after the worker process restarts
   * (the durable session log is owned by the remote DSH host, not by this bridge).
   */
  async resumeSession(params = {}) {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : ''
    if (sessionId === '') throw new RemoteControlError('session/invalid-id', 'resume requires a non-empty sessionId', 400)
    const existing = this.sessions.get(sessionId)
    if (existing !== undefined) return { sessionId, cwd: existing.cwd, resumed: false, provider: existing.agentOptions.provider, model: existing.agentOptions.model }
    const agentOptions = this.agentOptions({
      provider: params.provider,
      model: params.model,
      reasoningEffort: params.reasoningEffort,
      maxTokens: params.maxTokens,
    })
    let handle
    try {
      handle = await this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions })
    } catch (error) {
      throw new RemoteControlError('session/resume-failed', `failed to resume session ${sessionId} on the worker: ${error?.message ?? error}`, 400)
    }
    const cwd = typeof handle.agent?.session?.header?.cwd === 'string' ? handle.agent.session.header.cwd : resolve(this.config.workspaceRoot ?? process.cwd())
    const record = {
      sessionId,
      cwd,
      agentOptions,
      handle,
      transcript: new SessionTranscript({ maxEntries: this.config.maxEntries, maxToolResultChars: this.config.maxToolResultChars }),
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    }
    this.applyPermissionPreset(record)
    this.sessions.set(sessionId, record)
    this.log.info(`resumed session ${sessionId} (cwd=${cwd})`)
    return { sessionId, cwd, resumed: true, provider: agentOptions.provider, model: agentOptions.model }
  }

  /**
   * Pin the configured permission preset on a freshly created session.
   *
   * Remote sessions are unattended: nobody is sitting at the worker to answer an
   * approval prompt, so `ask` behaves as deny and long tool calls fail closed.
   * The worker therefore selects a preset such as `danger-full-access` (sandbox
   * `danger-full-access` + approval `never`) for the sessions it creates. The
   * preset is a per-session event, so the remote host's own GUI sessions keep
   * their configured policies. When the host does not mount the preset service,
   * the deployment's own defaults stay in effect and this is only logged.
   */
  applyPermissionPreset(record) {
    const presetName = this.config.permissionPreset
    if (presetName === undefined) return
    let service
    try {
      service = this.ctx.get('permissionPresets')
    } catch {
      service = undefined
    }
    if (service?.set === undefined) {
      this.log.warn('permission preset service is not mounted; remote sessions keep the host defaults')
      return
    }
    try {
      service.set(record.handle.agent.session, presetName)
    } catch (error) {
      this.log.warn(`could not apply permission preset ${JSON.stringify(presetName)}:`, error?.message ?? error)
    }
  }

  /** Snapshot of one session's status. */
  sessionStatus(sessionId) {
    const record = this.requireSession(sessionId)
    const agent = record.handle?.agent
    return {
      sessionId,
      cwd: record.cwd,
      status: agent?.status ?? 'unknown',
      idle: agent?.status === 'idle',
      seq: agent?.session?.seq ?? record.transcript.lastSeq,
      title: record.transcript.title,
      createdAt: new Date(record.createdAt).toISOString(),
      lastActivityAt: new Date(record.lastActivityAt).toISOString(),
      turnCount: record.transcript.turnCount,
      lastAssistantText: record.transcript.lastAssistantText,
      error: record.transcript.lastError,
      provider: record.agentOptions.provider,
      model: record.agentOptions.model,
    }
  }

  /** All live sessions on this worker. */
  listSessions() {
    return [...this.sessions.keys()].map((sessionId) => this.sessionStatus(sessionId))
  }

  /** Enqueue one user prompt on a live session. */
  async promptSession(sessionId, params = {}) {
    const record = this.requireSession(sessionId)
    const text = typeof params.text === 'string' ? params.text : typeof params.prompt === 'string' ? params.prompt : ''
    if (text.trim() === '') throw new RemoteControlError('prompt/empty', 'prompt text must be a non-empty string', 400)
    const message = deepFreeze({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    try {
      record.handle.agent.followup(message)
    } catch (error) {
      throw new RemoteControlError('prompt/rejected', `the remote agent rejected the prompt: ${error?.message ?? error}`, 409)
    }
    record.lastActivityAt = Date.now()
    return { messageId: message.id, status: record.handle.agent.status }
  }

  /** Read transcript items after a durable cursor. */
  readEvents(sessionId, afterSeq, url) {
    const record = this.requireSession(sessionId)
    const limit = clamp(url.searchParams.get('limit'), 1, 400, 200)
    const maxChars = clamp(url.searchParams.get('maxChars'), 500, 200000, this.config.maxTranscriptChars)
    const window = record.transcript.read(afterSeq, { limit, maxChars })
    return {
      sessionId,
      status: record.handle.agent.status,
      title: record.transcript.title,
      lastAssistantText: record.transcript.lastAssistantText,
      error: record.transcript.lastError,
      ...window,
    }
  }

  /** Long-poll until the session is fully idle, the timeout elapses, or the client disconnects. */
  async waitSession(sessionId, options) {
    const record = this.requireSession(sessionId)
    const idle = await this.waitUntilIdle(record, options.timeoutMs, options.signal)
    const window = record.transcript.read(options.afterSeq, { maxChars: this.config.maxTranscriptChars })
    return {
      sessionId,
      idle: idle === 'idle',
      outcome: idle,
      status: record.handle.agent.status,
      title: record.transcript.title,
      lastAssistantText: record.transcript.lastAssistantText,
      error: record.transcript.lastError,
      turnCount: record.transcript.turnCount,
      ...window,
    }
  }

  /** Wait for the root agent and its managed in-process descendants to become idle. */
  async waitUntilIdle(record, timeoutMs, signal) {
    const agent = record.handle.agent
    const deadline = Date.now() + Math.max(0, timeoutMs)
    const subagents = (() => {
      try {
        return this.ctx.get('subagents')
      } catch {
        return undefined
      }
    })()
    for (;;) {
      if (signal?.aborted === true) return 'aborted'
      const remaining = deadline - Date.now()
      if (remaining <= 0) return 'timeout'
      const idleOutcome = await raceTimeout(agent.whenIdle().then(() => 'idle'), remaining, signal)
      if (idleOutcome !== 'idle') return idleOutcome
      const idleSeq = agent.session.seq
      if (subagents?.waitForChildren !== undefined) {
        const childrenOutcome = await raceTimeout(Promise.resolve(subagents.waitForChildren(agent)), Math.max(1, deadline - Date.now()), signal)
        if (childrenOutcome === 'timeout' || childrenOutcome === 'aborted') return childrenOutcome
        if (childrenOutcome === true) continue
      }
      if (agent.status === 'idle' && agent.session.seq === idleSeq) return 'idle'
    }
  }

  /** Cancel the session's current turn (queued input is discarded). */
  async abortSession(sessionId) {
    const record = this.requireSession(sessionId)
    try {
      await record.handle.agent.cancel({ kind: 'user' })
    } catch (error) {
      throw new RemoteControlError('session/abort-failed', `failed to abort the remote session: ${error?.message ?? error}`, 500)
    }
    record.lastActivityAt = Date.now()
    return { aborted: true, status: record.handle.agent.status }
  }

  /** Dispose the agent handle and forget the session (its log stays in the host's store). */
  async closeSession(sessionId) {
    const record = this.requireSession(sessionId)
    this.sessions.delete(sessionId)
    try {
      await record.handle.dispose()
    } catch (error) {
      this.log.warn(`failed to dispose session ${sessionId}:`, error)
    }
    return { closed: true, sessionId }
  }
}

/** Resolve to the raced value, or `timeout` / `aborted`. */
function raceTimeout(promise, timeoutMs, signal) {
  return new Promise((resolveRace) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      resolveRace(value)
    }
    const timer = setTimeout(() => finish('timeout'), Math.max(1, timeoutMs))
    if (typeof timer.unref === 'function') timer.unref()
    const onAbort = () => finish('aborted')
    if (signal !== undefined) {
      if (signal.aborted) {
        finish('aborted')
        return
      }
      signal.addEventListener?.('abort', onAbort, { once: true })
    }
    promise.then(
      (value) => finish(value),
      (error) => finish({ error }),
    )
  })
}

/**
 * Cordis plugin entry: mount the worker HTTP server for this profile.
 * @param {import('@deepseek-ai/cordis').Context} ctx context providing `agents`.
 * @param {Record<string, unknown>} config profile row config.
 */
export function apply(ctx, config) {
  const runtime = new WorkerRuntime(ctx, config)
  ctx.effect(() => {
    runtime.open()
    return () => runtime.close()
  }, 'remote-control.worker')
}
