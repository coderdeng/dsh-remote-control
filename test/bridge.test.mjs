// Self-contained tests for the remote-control bridge: no DSH runtime needed.
// The worker runs over real HTTP on loopback and the controller talks to it,
// with fake Cordis contexts implementing only the documented services.
//
// Run: node --test plugins/dsh-remote-control/test/bridge.test.mjs

// Run against an isolated harness home so state files never touch the real one.
process.env.DSH_HOME = join(tmpdir(), 'dsh-remote-control-test-home')

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'

import {
  PLUGIN_VERSION,
  PROTOCOL_VERSION,
  RemoteControlError,
  SessionTranscript,
  decodePairingCode,
  encodePairingCode,
  normalizeHost,
  renderEvent,
  tokenMatches,
} from '../lib/protocol.js'
import { WorkerRuntime, normalizeWorkerConfig } from '../lib/worker.js'
import { ControllerRuntime, normalizeControllerConfig } from '../lib/controller.js'

// ---------------------------------------------------------------------------
// test doubles
// ---------------------------------------------------------------------------

/** A fake DSH agent handle with just the surface the worker uses. */
class FakeAgent {
  constructor() {
    this.status = 'idle'
    this.session = { seq: 0 }
    this.inbox = []
    this.waiters = []
    this.disposed = false
  }

  followup(message) {
    if (this.disposed) throw new Error('disposed')
    this.inbox.push(message)
    this.status = 'running'
    this.session.seq += 1
    setTimeout(() => this.finishTurn(`reply to: ${message.content[0].text}`), 20)
  }

  finishTurn(text) {
    if (this.disposed) return
    this.session.seq += 1
    this.emit('assistant/message', { message: { content: [{ type: 'text', text }] } })
    this.session.seq += 1
    this.emit('turn/end', { reason: { kind: 'completed' } })
    this.status = 'idle'
    for (const waiter of this.waiters.splice(0)) waiter()
  }

  emit(type, data) {
    for (const listener of this.listeners ?? []) listener({ id: this.session.id }, { type, data, seq: this.session.seq })
  }

  whenIdle() {
    if (this.status === 'idle') return Promise.resolve()
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  async cancel() {
    this.status = 'idle'
    for (const waiter of this.waiters.splice(0)) waiter()
  }

  async dispose() {
    this.disposed = true
    this.status = 'idle'
    for (const waiter of this.waiters.splice(0)) waiter()
  }
}

/** Minimal Cordis-like context for the worker role. */
function fakeWorkerContext() {
  const listeners = []
  const fake = new FakeAgent()
  const agents = {
    async create({ sessionId }) {
      fake.session.id = sessionId
      fake.listeners = listeners.filter((entry) => entry.event === 'session/event').map((entry) => entry.listener)
      return { sessionId, agent: fake, dispose: () => fake.dispose() }
    },
  }
  return {
    fake,
    ctx: {
      agents,
      on(event, listener) {
        listeners.push({ event, listener })
        return () => {
          const index = listeners.findIndex((entry) => entry.listener === listener)
          if (index >= 0) listeners.splice(index, 1)
        }
      },
      get(serviceName) {
        if (serviceName === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }
        return undefined
      },
      effect() {
        return () => {}
      },
      logger() {
        return undefined
      },
    },
  }
}

/** Minimal Cordis-like context for the controller role. */
function fakeControllerContext() {
  const definitions = []
  return {
    definitions,
    ctx: {
      tools: {
        register(definition) {
          definitions.push(definition)
          return () => {}
        },
      },
      get() {
        return undefined
      },
      effect() {
        return () => {}
      },
      logger() {
        return undefined
      },
    },
  }
}

/** Pick a free loopback port. */
async function freePort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

/**
 * DSH rejects tool results that are not lossless JSON (for example a member
 * whose value is `undefined`). Mirror that check over every tool output.
 */
function assertLosslessJson(value, path = 'result') {
  if (value === undefined) throw new Error(`${path} contains undefined`)
  if (value === null) return
  const type = typeof value
  if (type === 'string' || type === 'boolean') return
  if (type === 'number') {
    assert.ok(Number.isFinite(value), `${path} contains a non-finite number`)
    return
  }
  assert.equal(type, 'object', `${path} contains a non-JSON ${type}`)
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertLosslessJson(entry, `${path}[${index}]`))
    return
  }
  for (const [key, entry] of Object.entries(value)) assertLosslessJson(entry, `${path}.${key}`)
}

// ---------------------------------------------------------------------------
// protocol-level tests
// ---------------------------------------------------------------------------

test('tokenMatches compares safely', () => {
  assert.equal(tokenMatches('abcdef', 'abcdef'), true)
  assert.equal(tokenMatches('abcdef', 'abcdeg'), false)
  assert.equal(tokenMatches('', ''), false)
  assert.equal(tokenMatches(undefined, 'abcdef'), false)
})

test('renderEvent renders the durable event shapes DSH writes', () => {
  assert.equal(
    renderEvent({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hello' }] } } }).text,
    'assistant: hello',
  )
  assert.equal(renderEvent({ type: 'user/message', data: { content: [{ type: 'text', text: 'do it' }] } }).text, 'user: do it')
  assert.match(
    renderEvent({ type: 'tool/call', data: { name: 'bash', arguments: { command: 'ls -la' } } }).text,
    /^tool bash\(\{.*ls -la.*\}\)$/u,
  )
  assert.match(
    renderEvent({ type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'a.txt' }] } } }).text,
    /^tool result: a\.txt$/u,
  )
  assert.match(renderEvent({ type: 'tool/result', data: { isError: true, message: { content: [{ type: 'text', text: 'boom' }] } } }).text, /^tool error: boom$/u)
  assert.equal(renderEvent({ type: 'turn/end', data: { reason: { kind: 'completed' } } }), undefined)
  assert.match(renderEvent({ type: 'turn/end', data: { reason: { kind: 'error', message: 'nope' } } }).text, /^turn ended: error/u)
  assert.equal(renderEvent({ type: 'step/start', data: {} }), undefined)
})

test('SessionTranscript keeps cursors and truncates tool output', () => {
  const transcript = new SessionTranscript({ maxToolResultChars: 10 })
  transcript.append({ type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'hi' }] } })
  transcript.append({ type: 'tool/result', seq: 2, data: { message: { content: [{ type: 'text', text: '0123456789abcdef' }] } } })
  const all = transcript.read(0)
  assert.equal(all.nextSeq, 2)
  assert.equal(all.count, 2)
  assert.match(all.text, /012345678…/u)
  const after = transcript.read(1)
  assert.equal(after.count, 1)
  assert.equal(after.nextSeq, 2)
})

test('normalizeHost validates and normalizes entries', () => {
  assert.deepEqual(normalizeHost('a', { endpoint: 'http://10.0.0.2:7801/', token: 'x'.repeat(20) }), {
    name: 'a',
    endpoint: 'http://10.0.0.2:7801',
    token: 'x'.repeat(20),
  })
  assert.throws(() => normalizeHost('a', { endpoint: 'ftp://x', token: 't' }), /http/u)
  assert.throws(() => normalizeHost('a', { endpoint: 'http://x' }), /token/u)
  assert.throws(() => normalizeHost('a', 'http://10.0.0.2:7801/'), /token/u)
})

test('worker config auto-generates a token when omitted, rejects short configured tokens', () => {
  const generated = normalizeWorkerConfig({})
  assert.equal(generated.tokenSource, 'generated')
  assert.equal(generated.token.length, 48)
  assert.throws(() => normalizeWorkerConfig({ token: 'short' }), /16 characters/u)
  const config = normalizeWorkerConfig({ token: 'x'.repeat(24), port: '8080', listenHost: '' })
  assert.equal(config.port, 8080)
  assert.equal(config.listenHost, '0.0.0.0')
  assert.equal(config.tokenSource, 'config')
})

test('pairing codes round-trip endpoint, name and token', () => {
  const code = encodePairingCode({ name: 'work-mac', endpoint: 'http://192.168.1.20:7801', token: 't'.repeat(24) })
  assert.ok(code.startsWith('dshrc1.'))
  const host = decodePairingCode(code)
  assert.equal(host.name, 'work-mac')
  assert.equal(host.endpoint, 'http://192.168.1.20:7801')
  assert.equal(host.token, 't'.repeat(24))
  assert.throws(() => decodePairingCode('nope'), /invalid pairing code/u)
  assert.throws(() => decodePairingCode('dshrc1.bm90LWpzb24'), /invalid pairing code/u)
})

test('controller config tolerates an empty host list until configured', () => {
  assert.equal(normalizeControllerConfig({}).hosts.size, 0)
  assert.throws(
    () => normalizeControllerConfig({ hosts: [
      { name: 'a', endpoint: 'http://127.0.0.1:1', token: 't' },
      { name: 'a', endpoint: 'http://127.0.0.1:2', token: 't' },
    ] }),
    /duplicate host/u,
  )
})

// ---------------------------------------------------------------------------
// end-to-end HTTP bridge test (worker server <-> controller HTTP client)
// ---------------------------------------------------------------------------

test('worker serves sessions and controller drives them end to end', async () => {
  const { ctx, fake } = fakeWorkerContext()
  const port = await freePort()
  const token = 'test-token-0123456789'
  const worker = new WorkerRuntime(ctx, {
    token,
    listenHost: '127.0.0.1',
    port,
    maxTranscriptChars: 4000,
  })
  worker.open()

  try {
    // Unauthenticated requests are rejected.
    const denied = await fetch(`http://127.0.0.1:${port}/v1/hello`)
    assert.equal(denied.status, 401)

    const hello = await fetch(`http://127.0.0.1:${port}/v1/hello`, { headers: { authorization: `Bearer ${token}` } })
    const helloBody = await hello.json()
    assert.equal(helloBody.ok, true)
    assert.equal(helloBody.protocol, PROTOCOL_VERSION)
    assert.equal(helloBody.version, PLUGIN_VERSION)
    assert.equal(helloBody.selection.provider, 'fake-provider')

    // Controller side: register the tools against a fake registry.
    const { ctx: controllerCtx, definitions } = fakeControllerContext()
    const controller = new ControllerRuntime(controllerCtx, {
      hosts: [{ name: 'remote', endpoint: `http://127.0.0.1:${port}`, token }],
      startWaitMs: 2000,
      defaultWaitTimeoutMs: 2000,
    })
    controller.register()
    const byName = new Map(definitions.map((definition) => [definition.name, definition]))
    assert.ok(byName.has('remote_dsh_hosts'))
    assert.ok(byName.has('remote_dsh_start'))
    assert.ok(byName.has('remote_dsh_wait'))

    const assertOutput = (value) => assertLosslessJson(value)
    const exec = { signal: new AbortController().signal }
    const hosts = await byName.get('remote_dsh_hosts').execute({}, exec)
    assertOutput(hosts)
    assert.equal(hosts.hosts.length, 1)
    assert.equal(hosts.hosts[0].online, true)

    const started = await byName.get('remote_dsh_start').execute({ host: 'remote', prompt: 'say hi', waitMs: 1500 }, exec)
    assert.equal(started.host, 'remote')
    assert.ok(started.sessionId.startsWith('session-'))
    assert.equal(started.idle, true)
    assertOutput(started)
    assert.match(started.output, /assistant: reply to: say hi/u)

    // A follow-up via send + wait reads only the new transcript.
    const sent = await byName.get('remote_dsh_send').execute({ host: 'remote', sessionId: started.sessionId, text: 'again' }, exec)
    assertOutput(sent)
    assert.equal(sent.status, 'running')
    const waited = await byName.get('remote_dsh_wait').execute({ host: 'remote', sessionId: started.sessionId, timeoutMs: 2000 }, exec)
    assertOutput(waited)
    assert.equal(waited.idle, true)
    assert.match(waited.output, /reply to: again/u)
    assert.doesNotMatch(waited.output, /reply to: say hi/u)

    const status = await byName.get('remote_dsh_status').execute({ host: 'remote', sessionId: started.sessionId }, exec)
    assertOutput(status)
    assert.equal(status.session.status, 'idle')
    assert.equal(status.session.turnCount, 2)

    const listed = await byName.get('remote_dsh_status').execute({ host: 'remote' }, exec)
    assertOutput(listed)
    assert.equal(listed.sessions.length, 1)

    const log = await byName.get('remote_dsh_log').execute({ host: 'remote', sessionId: started.sessionId, afterSeq: 0 }, exec)
    assertOutput(log)
    assert.match(log.output, /say hi/u)
    assert.match(log.output, /again/u)

    const aborted = await byName.get('remote_dsh_abort').execute({ host: 'remote', sessionId: started.sessionId }, exec)
    assertOutput(aborted)
    assert.equal(aborted.aborted, true)
    assert.equal(fake.inbox.length, 2)

    // Pairing flow: a fresh controller with zero configured hosts pairs the running
    // worker from its pairing code, persists it under DSH_HOME, and can unpair it.
    assert.ok(helloBody.pairing.code.startsWith('dshrc1.'))
    assert.equal(decodePairingCode(helloBody.pairing.code).endpoint, `http://127.0.0.1:${port}`)
    const { ctx: pairingCtx, definitions: pairingDefinitions } = fakeControllerContext()
    const pairingController = new ControllerRuntime(pairingCtx, {})
    pairingController.register()
    const pairTools = new Map(pairingDefinitions.map((definition) => [definition.name, definition]))
    const pairedCode = encodePairingCode({ name: 'paired-remote', endpoint: `http://127.0.0.1:${port}`, token })
    const paired = await pairTools.get('remote_dsh_pair').execute({ code: pairedCode }, exec)
    assertOutput(paired)
    assert.equal(paired.paired, true)
    assert.equal(paired.host, 'paired-remote')
    assert.equal(paired.updated, false)
    const pairedHosts = await pairTools.get('remote_dsh_hosts').execute({}, exec)
    assertOutput(pairedHosts)
    assert.equal(pairedHosts.hosts.length, 1)
    assert.equal(pairedHosts.hosts[0].online, true)
    const stateFile = join(process.env.DSH_HOME, 'dsh-remote-control', 'hosts.json')
    const stateDocument = JSON.parse(await readFile(stateFile, 'utf8'))
    assert.equal(stateDocument.hosts[0].name, 'paired-remote')
    assert.equal(stateDocument.hosts[0].endpoint, `http://127.0.0.1:${port}`)
    const removed = await pairTools.get('remote_dsh_unpair').execute({ name: 'paired-remote' }, exec)
    assert.equal(removed.removed, 'paired-remote')
    assert.deepEqual(removed.remaining, [])
    const repersisted = JSON.parse(await readFile(stateFile, 'utf8'))
    assert.deepEqual(repersisted.hosts, [])

    // Renderers return model-readable text for every tool.
    for (const definition of definitions) {
      const rendered = definition.output.render({}, { paired: true, updated: false, host: 'remote', endpoint: 'http://x', sessionId: 'session-x', status: 'idle', output: 'out', nextSeq: 1, sessions: [], remaining: [], controller: { hostname: 'h', pluginVersion: 'v', protocol: 1 }, hosts: [] })
      assert.ok(Array.isArray(rendered) && rendered[0].type === 'text' && typeof rendered[0].text === 'string')
    }
  } finally {
    await worker.close()
  }
})

test('worker falls back to the next free port when the configured one is taken', async () => {
  const { ctx } = fakeWorkerContext()
  const port = await freePort()
  const token = 'fallback-token-0123456789'
  const first = new WorkerRuntime(ctx, { token, listenHost: '127.0.0.1', port })
  first.open()
  const second = new WorkerRuntime(ctx, { token, listenHost: '127.0.0.1', port })
  try {
    second.open()
    const deadline = Date.now() + 5000
    while (second.boundPort === undefined && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
    assert.ok(second.boundPort !== undefined)
    assert.notEqual(second.boundPort, first.boundPort)
    const response = await fetch(`http://127.0.0.1:${second.boundPort}/v1/hello`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(response.status, 200)
  } finally {
    await second.close()
    await first.close()
  }
})
