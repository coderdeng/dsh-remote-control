// Smoke test for a remote-control worker: proves the bridge, the remote model
// route, session persistence and resume all work. Safe to run repeatedly.
//
// Usage:
//   node tools/worker-smoke.mjs <endpoint> <token> [--cwd <remote dir>]
//
// Exit code 0 means: hello ok, a session ran a prompt to completion, the session
// was closed, the persisted session was resumed, and the remote agent answered
// again in the same conversation.

const args = process.argv.slice(2)
const endpoint = (args[0] ?? 'http://127.0.0.1:7801').replace(/\/+$/u, '')
const token = args[1]
if (!token) {
  console.error('usage: node tools/worker-smoke.mjs <endpoint> <token> [--cwd <remote dir>]')
  process.exit(2)
}
let cwd
for (let index = 2; index < args.length; index += 1) {
  if (args[index] === '--cwd') cwd = args[++index]
}

const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
async function call(method, path, body) {
  const response = await fetch(`${endpoint}/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const text = await response.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`${method} ${path}: non-JSON response HTTP ${response.status}`)
  }
  if (!response.ok || payload.ok === false) throw new Error(`${method} ${path}: ${payload?.error?.code ?? response.status}: ${payload?.error?.message ?? text.slice(0, 300)}`)
  return payload
}
async function waitIdle(sessionId, cursor, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error('timed out waiting for the remote agent to become idle')
    const waited = await call('GET', `/sessions/${encodeURIComponent(sessionId)}/wait?timeoutMs=${Math.min(remaining, 60000)}&afterSeq=${cursor}`)
    if (waited.text) console.log(waited.text)
    if (waited.idle === true) return waited
    cursor = waited.nextSeq
  }
}

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

const hello = await call('GET', '/hello')
check('hello', hello.ok === true, `${hello.worker.hostname} ${hello.worker.platform}, ${hello.selection.provider}/${hello.selection.model}, permission=${hello.permissionPreset ?? '(host default)'}`)

const created = await call('POST', '/sessions', { cwd })
check('session create', typeof created.sessionId === 'string', created.sessionId)
await call('POST', `/sessions/${encodeURIComponent(created.sessionId)}/prompt`, { text: '请只回复这串字符，不要添加其他内容：SMOKE-OK' })
const first = await waitIdle(created.sessionId, 0)
check('prompt completed', first.idle === true, `status=${first.status}`)
check('model answered', typeof first.lastAssistantText === 'string' && first.lastAssistantText.includes('SMOKE-OK'), first.lastAssistantText?.slice(0, 80))

await call('POST', `/sessions/${encodeURIComponent(created.sessionId)}/close`, {})
const resumed = await call('POST', '/sessions/resume', { sessionId: created.sessionId })
check('session resume', resumed.sessionId === created.sessionId, `cwd=${resumed.cwd}`)
await call('POST', `/sessions/${encodeURIComponent(created.sessionId)}/prompt`, { text: '我刚才让你回复的那串字符是什么？只回复那串字符。' })
const second = await waitIdle(created.sessionId, 0)
check('resumed session answered', second.idle === true && typeof second.lastAssistantText === 'string' && second.lastAssistantText.includes('SMOKE-OK'), second.lastAssistantText?.slice(0, 80))
await call('POST', `/sessions/${encodeURIComponent(created.sessionId)}/close`, {})

console.log(failures === 0 ? '\nSMOKE OK' : `\nSMOKE FAILED (${failures} check(s))`)
process.exit(failures === 0 ? 0 : 1)
