/**
 * Shared vocabulary for the DSH remote-control bridge: HTTP JSON protocol,
 * transcript rendering of durable session events, and defensive helpers.
 *
 * This module has no imports outside `node:` builtins on purpose: the plugin is
 * loaded either as an installed package or straight from a file path in a
 * profile patch, and must work in both cases on Windows, macOS and Linux.
 *
 * @module dsh-remote-control/protocol
 */

/** Wire protocol version advertised by the worker and required by the controller. */
export const PROTOCOL_VERSION = 1

/** Plugin version (also shown by `remote_dsh_hosts`). */
export const PLUGIN_VERSION = '0.2.1'

/** Prefix of every HTTP route served by the worker. */
export const API_PREFIX = '/v1'

/** Default port of the worker HTTP server. */
export const DEFAULT_PORT = 7801

/** Default bind address: all interfaces, so a LAN peer can reach the worker. */
export const DEFAULT_LISTEN_HOST = '0.0.0.0'

/** JSON body size ceiling for worker requests. */
export const MAX_BODY_BYTES = 1024 * 1024

// ---------------------------------------------------------------------------
// errors and HTTP plumbing
// ---------------------------------------------------------------------------

/** An error that carries the HTTP status and stable machine code to report. */
export class RemoteControlError extends Error {
  /**
   * @param {string} code stable error code, e.g. `session/not-found`.
   * @param {string} message human-readable message.
   * @param {number} [status] HTTP status for worker responses.
   */
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'RemoteControlError'
    this.code = code
    this.status = status
  }
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res response.
 * @param {number} status HTTP status.
 * @param {unknown} payload JSON payload.
 */
export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}

/**
 * Read and parse a bounded JSON request body.
 * @param {import('node:http').IncomingMessage} req request.
 * @param {number} [limitBytes] body ceiling.
 * @returns {Promise<Record<string, unknown>>} parsed object body.
 */
export async function readJsonBody(req, limitBytes = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limitBytes) throw new RemoteControlError('request/too-large', `request body exceeds ${limitBytes} bytes`, 413)
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  let value
  try {
    value = JSON.parse(text)
  } catch {
    throw new RemoteControlError('request/invalid-json', 'request body is not valid JSON', 400)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RemoteControlError('request/invalid-json', 'request body must be a JSON object', 400)
  }
  return value
}

/**
 * Constant-time bearer-token comparison.
 * @param {string | undefined} provided token from the request.
 * @param {string} expected configured token.
 * @returns {boolean} whether they match.
 */
export function tokenMatches(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || expected.length === 0) return false
  // Hash both sides so `timingSafeEqual` sees equal lengths even for unequal input.
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/** Extract the bearer token of a request: Authorization header, then query token. */
export function tokenOf(req, url) {
  const header = req.headers?.authorization
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/iu.exec(header.trim())
    if (match) return match[1].trim()
  }
  const query = url?.searchParams?.get('token')
  return typeof query === 'string' && query.length > 0 ? query : undefined
}

/** Parse a positive integer query parameter, returning `undefined` when absent/invalid. */
export function intParam(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  const parsed = Number.parseInt(String(value), 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

/** Clamp a number into an inclusive range, falling back when not finite. */
export function clamp(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

// ---------------------------------------------------------------------------
// import-free constants injected below (declared after use is fine in ESM only
// for functions, so the imports are hoisted to the top instead).
// ---------------------------------------------------------------------------
import { createHash, timingSafeEqual } from 'node:crypto'
import { homedir, networkInterfaces } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// transcript rendering over durable session events
// ---------------------------------------------------------------------------

/** Plain text of one message content array, tolerating unknown block types. */
export function blocksToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') parts.push('[image]')
    else if (block.type === 'attachment' || block.type === 'file') parts.push(`[attachment${block.attachment?.mediaType ? ` ${block.attachment.mediaType}` : ''}]`)
    else if (block.type === 'tool-result' || block.type === 'tool_result') parts.push(blocksToText(block.content))
  }
  return parts.join('')
}

/** Structural JSON preview with a character ceiling. */
export function jsonPreview(value, maxChars = 240) {
  let text
  if (typeof value === 'string') text = value
  else {
    try {
      text = JSON.stringify(value)
    } catch {
      text = String(value)
    }
  }
  if (text === undefined) return ''
  return truncate(text, maxChars)
}

/** Truncate with an explicit marker; keeps short text untouched. */
export function truncate(text, maxChars) {
  if (typeof text !== 'string') return ''
  if (text.length <= maxChars) return text
  if (maxChars <= 1) return text.slice(0, maxChars)
  return `${text.slice(0, maxChars - 1)}…`
}

/** Content of the message carried by an event's data, when it has one. */
function messageContent(data) {
  if (data === null || typeof data !== 'object') return undefined
  if (data.message !== null && typeof data.message === 'object' && 'content' in data.message) return data.message.content
  if ('content' in data) return data.content
  const result = data.result
  if (result !== null && typeof result === 'object' && 'content' in result) return result.content
  return undefined
}

/** Tool name of a `tool/call` payload, tolerating envelope differences. */
function callName(data) {
  if (data === null || typeof data !== 'object') return 'tool'
  if (typeof data.name === 'string') return data.name
  if (data.call !== null && typeof data.call === 'object' && typeof data.call.name === 'string') return data.call.name
  return 'tool'
}

/** Tool arguments of a `tool/call` payload, tolerating envelope differences. */
function callArguments(data) {
  if (data === null || typeof data !== 'object') return undefined
  if ('arguments' in data) return data.arguments
  if (data.call !== null && typeof data.call === 'object' && 'arguments' in data.call) return data.call.arguments
  return undefined
}

/**
 * One durable session event rendered as model-readable transcript text.
 * Tool-heavy events are shortened so a long remote session stays cheap to read.
 * @param {{ type?: string, seq?: number, data?: unknown }} event durable event.
 * @param {{ maxToolResultChars?: number, maxToolCallChars?: number }} [options] render limits.
 * @returns {{ kind: string, text: string, role?: string } | undefined} one transcript item, or undefined to skip.
 */
export function renderEvent(event, options = {}) {
  const maxToolResultChars = options.maxToolResultChars ?? 900
  const maxToolCallChars = options.maxToolCallChars ?? 240
  const type = typeof event?.type === 'string' ? event.type : ''
  const data = event?.data ?? {}
  switch (type) {
    case 'user/message': {
      const text = blocksToText(messageContent(data))
      if (text.trim() === '') return undefined
      return { kind: 'user', role: 'user', text: `user: ${text}` }
    }
    case 'assistant/message': {
      const text = blocksToText(messageContent(data))
      if (text.trim() === '') return undefined
      return { kind: 'assistant', role: 'assistant', text: `assistant: ${text}` }
    }
    case 'tool/call': {
      const name = callName(data)
      const args = jsonPreview(callArguments(data), maxToolCallChars)
      return { kind: 'tool-call', text: args ? `tool ${name}(${args})` : `tool ${name}()` }
    }
    case 'tool/result': {
      const text = blocksToText(messageContent(data))
      const isError = data && typeof data === 'object' && (data.isError === true || data.error !== undefined)
      const preview = truncate(text.trim(), maxToolResultChars)
      if (isError) return { kind: 'tool-result', text: `tool error: ${preview || '(no content)'}` }
      return { kind: 'tool-result', text: preview === '' ? 'tool result (empty)' : `tool result: ${preview}` }
    }
    case 'turn/end': {
      const reason = data && typeof data === 'object' ? data.reason : undefined
      const kind = reason && typeof reason === 'object' && typeof reason.kind === 'string' ? reason.kind : 'completed'
      if (kind === 'completed') return undefined
      const message = reason && typeof reason === 'object' && typeof reason.message === 'string' ? ` (${reason.message})` : ''
      return { kind: 'turn', text: `turn ended: ${kind}${message}` }
    }
    case 'approval/asked': {
      return { kind: 'notice', text: 'approval requested on the remote host' }
    }
    case 'permission/preset': {
      const preset = data && typeof data === 'object'
        ? (typeof data.preset === 'string' ? data.preset : typeof data.mode === 'string' ? data.mode : undefined)
        : undefined
      if (preset === undefined) return undefined
      return { kind: 'notice', text: `permission preset: ${preset}` }
    }
    case 'sandbox/mode': {
      const mode = data && typeof data === 'object' && typeof data.mode === 'string' ? data.mode : undefined
      return mode === undefined ? undefined : { kind: 'notice', text: `sandbox mode: ${mode}` }
    }
    case 'session/title': {
      const title = data && typeof data === 'object' && typeof data.title === 'string' ? data.title : undefined
      return title === undefined ? undefined : { kind: 'title', text: `session title: ${title}` }
    }
    case 'llm/retry':
    case 'llm/retry-started': {
      return { kind: 'notice', text: 'model request retried' }
    }
    case 'compaction/end':
    case 'compaction/summary': {
      return { kind: 'notice', text: 'conversation compacted on the remote host' }
    }
    case 'agent/error': {
      const message = data && typeof data === 'object' && data.error ? String(data.error.message ?? data.error) : 'unknown error'
      return { kind: 'error', text: `agent error: ${truncate(message, 600)}` }
    }
    default:
      return undefined
  }
}

/**
 * Per-session transcript ring buffer keyed by durable sequence numbers.
 * Cursors are the durable `seq` of the last item a reader has seen, so a
 * controller can poll only what is new without re-reading the session log.
 */
export class SessionTranscript {
  /**
   * @param {{ maxEntries?: number, maxToolResultChars?: number, maxToolCallChars?: number }} [options] limits.
   */
  constructor(options = {}) {
    this.maxEntries = options.maxEntries ?? 4000
    this.renderOptions = {
      maxToolResultChars: options.maxToolResultChars,
      maxToolCallChars: options.maxToolCallChars,
    }
    /** @type {{ seq: number, kind: string, text: string }[]} */
    this.entries = []
    this.lastSeq = 0
    this.title = undefined
    this.lastAssistantText = ''
    this.lastError = undefined
    this.turnCount = 0
  }

  /** Append one durable session event (no-op for events without a transcript rendering). */
  append(event) {
    const seq = typeof event?.seq === 'number' && Number.isFinite(event.seq) ? event.seq : this.lastSeq + 1
    this.lastSeq = Math.max(this.lastSeq, seq)
    const type = event?.type
    const data = event?.data
    if (type === 'assistant/message') {
      const text = blocksToText(messageContent(data)).trim()
      if (text !== '') this.lastAssistantText = text
    } else if (type === 'turn/end') {
      const kind = data?.reason?.kind ?? 'completed'
      if (kind === 'completed') this.turnCount += 1
    } else if (type === 'agent/error') {
      const message = data?.error?.message ?? data?.error ?? 'unknown error'
      this.lastError = `agent error: ${truncate(String(message), 600)}`
    }
    const rendered = renderEvent(event, this.renderOptions)
    if (rendered === undefined) return
    if (rendered.kind === 'title') this.title = rendered.text.replace(/^session title: /u, '')
    this.entries.push({ seq, kind: rendered.kind, text: rendered.text })
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries)
  }

  /** Record an out-of-band failure (agent/error) as an explicit transcript line. */
  appendError(text) {
    this.lastError = text
    this.entries.push({ seq: this.lastSeq, kind: 'error', text })
    if (this.entries.length > this.maxEntries) this.entries.splice(0, this.entries.length - this.maxEntries)
  }

  /**
   * Transcript items after a cursor, rendered within a character budget.
   * @param {number} afterSeq exclusive cursor.
   * @param {{ maxChars?: number, limit?: number }} [options] budget.
   * @returns {{ text: string, nextSeq: number, count: number, truncated: boolean }} window.
   */
  read(afterSeq = 0, options = {}) {
    const maxChars = options.maxChars ?? 12000
    const limit = options.limit ?? 400
    const fresh = this.entries.filter((entry) => entry.seq > afterSeq)
    const window = fresh.slice(0, limit)
    const lines = window.map((entry) => entry.text)
    let text = lines.join('\n')
    let truncated = false
    if (text.length > maxChars) {
      // Keep both ends: the beginning carries the task framing, the end carries the latest state.
      const half = Math.floor(maxChars / 2)
      text = `${text.slice(0, half)}\n… [${text.length - maxChars} characters omitted] …\n${text.slice(text.length - (maxChars - half))}`
      truncated = true
    }
    const nextSeq = window.length > 0 ? window[window.length - 1].seq : afterSeq
    return { text, nextSeq, count: window.length, truncated }
  }
}

/**
 * Normalize one configured controller host entry.
 * @param {string} fallbackName name derived from the position in config.
 * @param {unknown} entry raw config value.
 * @returns {{ name: string, endpoint: string, token: string, description?: string, workdir?: string }} host.
 */
export function normalizeHost(fallbackName, entry) {
  if (typeof entry === 'string') entry = { endpoint: entry }
  if (entry === null || typeof entry !== 'object') throw new RemoteControlError('config/invalid-host', `host ${fallbackName}: expected an object with endpoint/token`, 500)
  const record = /** @type {Record<string, unknown>} */ (entry)
  const name = typeof record.name === 'string' && record.name.length > 0 ? record.name : fallbackName
  const endpointRaw = typeof record.endpoint === 'string' ? record.endpoint : typeof record.url === 'string' ? record.url : undefined
  if (endpointRaw === undefined || endpointRaw.length === 0) throw new RemoteControlError('config/invalid-host', `host ${name}: an endpoint URL is required`, 500)
  const endpoint = endpointRaw.replace(/\/+$/u, '')
  if (!/^https?:\/\//iu.test(endpoint)) throw new RemoteControlError('config/invalid-host', `host ${name}: endpoint must start with http:// or https://`, 500)
  const token = typeof record.token === 'string' ? record.token : ''
  if (token.length === 0) throw new RemoteControlError('config/invalid-host', `host ${name}: a shared token is required`, 500)
  return {
    name,
    endpoint,
    token,
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
    ...(typeof record.workdir === 'string' && record.workdir.length > 0 ? { workdir: record.workdir } : {}),
  }
}

// ---------------------------------------------------------------------------
// pairing, LAN discovery and local state paths
// ---------------------------------------------------------------------------

/** Harness home directory of the current process (defaults to `~/.dsh`). */
export function dshHomeDir() {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh')
}

/** Directory this plugin may keep its own local state in. */
export function remoteControlStateDir() {
  return join(dshHomeDir(), 'dsh-remote-control')
}

/** Best-effort LAN IPv4 address of this machine (prefers private ranges). */
export function firstLanAddress() {
  try {
    const candidates = []
    for (const [name, addresses] of Object.entries(networkInterfaces())) {
      for (const address of addresses ?? []) {
        const family = address.family
        if (family !== 'IPv4' && family !== 4) continue
        if (address.internal) continue
        if (typeof address.address !== 'string') continue
        candidates.push({ address: address.address, name })
      }
    }
    const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/u.test(ip)
    const preferred = candidates.find((entry) => isPrivate(entry.address))
    return (preferred ?? candidates[0])?.address
  } catch {
    return undefined
  }
}

/** Prefix that marks a string as a remote-control pairing code. */
export const PAIRING_CODE_PREFIX = 'dshrc1.'

/**
 * Encode endpoint + token + display name into one pasteable pairing code.
 * The code contains the shared token, so it must be treated as a secret.
 * @param {{ name?: string, endpoint: string, token: string }} input host facts.
 * @returns {string} `<prefix><base64url(JSON)>`.
 */
export function encodePairingCode({ name, endpoint, token }) {
  const payload = JSON.stringify({
    v: 1,
    n: typeof name === 'string' && name.length > 0 ? name : undefined,
    e: endpoint,
    t: token,
  })
  return `${PAIRING_CODE_PREFIX}${Buffer.from(payload, 'utf8').toString('base64url')}`
}

/**
 * Decode a pairing code produced by {@link encodePairingCode}.
 * @param {string} code pasted pairing code.
 * @returns {{ name: string, endpoint: string, token: string }} normalized host.
 */
export function decodePairingCode(code) {
  if (typeof code !== 'string' || !code.startsWith(PAIRING_CODE_PREFIX)) {
    throw new RemoteControlError('pair/invalid-code', `invalid pairing code: expected it to start with ${PAIRING_CODE_PREFIX}`, 400)
  }
  let payload
  try {
    payload = JSON.parse(Buffer.from(code.slice(PAIRING_CODE_PREFIX.length), 'base64url').toString('utf8'))
  } catch {
    throw new RemoteControlError('pair/invalid-code', 'invalid pairing code: payload is not valid base64url JSON', 400)
  }
  if (payload === null || typeof payload !== 'object' || typeof payload.e !== 'string' || typeof payload.t !== 'string') {
    throw new RemoteControlError('pair/invalid-code', 'invalid pairing code: missing endpoint or token', 400)
  }
  return normalizeHost(typeof payload.n === 'string' && payload.n.length > 0 ? payload.n : 'remote', {
    name: payload.n,
    endpoint: payload.e,
    token: payload.t,
  })
}
