// Drive one DSH SDK profile over stdio JSON-RPC and print its session events.
// Used by the remote-control integration test to run a real controller agent
// (which has the remote_dsh_* tools) without the browser UI.
//
// Usage:
//   node tools/sdk-drive.mjs --dsh <dsh.cmd> --home <DSH_HOME> --profile <name>
//        --provider <provider> --model <model> [--cwd <dir>] --prompt <text>
//        [--timeout-ms <ms>]

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const options = {
  dsh: 'C:\\DSH\\resources\\runtime\\cli\\bin\\dsh.cmd',
  home: process.env.DSH_HOME,
  profile: 'sdk',
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  cwd: process.cwd(),
  prompt: '',
  timeoutMs: 300000,
}
const argv = process.argv.slice(2)
for (let index = 0; index < argv.length; index += 2) {
  const key = argv[index]?.replace(/^--/u, '').replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase())
  const value = argv[index + 1]
  if (!(key in options)) {
    console.error(`unknown option --${argv[index]?.replace(/^--/u, '')}`)
    process.exit(2)
  }
  options[key] = key === 'timeoutMs' ? Number(value) : value
}
if (!options.home || !options.prompt) {
  console.error('usage: node tools/sdk-drive.mjs --home <DSH_HOME> --prompt <text> [--profile sdk] [--provider p] [--model m] [--cwd d] [--timeout-ms ms]')
  process.exit(2)
}

const env = { ...process.env, DSH_HOME: options.home }
// The SDK profile serves JSON-RPC on stdout; keep diagnostics off stdout.
const child = spawn('cmd.exe', ['/c', options.dsh, '--profile', options.profile], {
  cwd: options.cwd,
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})

const pending = new Map()
let nextId = 1
let assistantText = ''
let sessionId = `session-${crypto.randomUUID()}`
let finished = false

function request(method, params) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content.map((block) => (block?.type === 'text' ? block.text : block?.type === 'image' ? '[image]' : '')).join('')
}

const reader = createInterface({ input: child.stdout, crlfDelay: Infinity })
reader.on('line', (line) => {
  let frame
  try {
    frame = JSON.parse(line)
  } catch {
    return
  }
  if (frame.id !== undefined) {
    const entry = pending.get(frame.id)
    if (entry === undefined) return
    pending.delete(frame.id)
    if (frame.error) entry.reject(new Error(`${frame.error.code}: ${frame.error.message}`))
    else entry.resolve(frame.result)
    return
  }
  const params = frame.params ?? {}
  if (frame.method === 'session.event') {
    const event = params.event ?? {}
    const data = event.data ?? {}
    const type = event.type
    if (type === 'assistant/message') {
      const text = textOf(data.message?.content)
      if (text.trim() !== '') {
        assistantText = text
        console.log(`\n[assistant] ${text}`)
      }
    } else if (type === 'tool/call') {
      console.log(`\n[tool] ${data.name ?? 'tool'}(${JSON.stringify(data.arguments ?? {}).slice(0, 300)})`)
    } else if (type === 'tool/result') {
      const text = textOf(data.message?.content)
      console.log(`[result] ${text.slice(0, 400).replace(/\n/gu, ' ')}`)
    } else if (type === 'turn/end') {
      console.log(`[turn/end] ${data.reason?.kind ?? 'completed'}`)
    }
  } else if (frame.method === 'session.status') {
    console.log(`[status] ${params.sessionId}: ${params.status}`)
  }
})
child.stderr.on('data', (chunk) => process.stderr.write(chunk))

const timer = setTimeout(() => {
  console.error(`\ntimed out after ${options.timeoutMs} ms`)
  child.kill('SIGKILL')
  process.exit(1)
}, Math.max(1000, options.timeoutMs))
if (typeof timer.unref === 'function') timer.unref()

try {
  const init = await request('initialize', {
    cwd: options.cwd,
    provider: options.provider,
    model: options.model,
  })
  console.log(`[sdk] ${init.serverInfo?.name} ${init.serverInfo?.version}`)
  await request('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text: options.prompt }] })
  await request('session/wait', { sessionId })
  console.log('\n=== final assistant message ===')
  console.log(assistantText)
  finished = true
  await request('shutdown', {}).catch(() => {})
} catch (error) {
  console.error(`\n[dsh sdk] ${error.message}`)
  process.exitCode = 1
} finally {
  clearTimeout(timer)
  child.stdin.end()
  setTimeout(() => child.kill('SIGKILL'), 2000).unref?.()
}
if (finished) setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref?.()
