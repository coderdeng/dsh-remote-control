// Small command-line client for a remote-control worker.
// Useful for debugging the bridge without the DSH controller, and as a demo.
//
// Usage:
//   node tools/worker-client.mjs <endpoint> <token> <prompt> [--cwd <path>] [--timeout-ms <ms>]
//
// Example:
//   node tools/worker-client.mjs http://127.0.0.1:7801 secret-token "列出当前目录并说明你是什么"

const args = process.argv.slice(2)
const endpoint = (args[0] ?? 'http://127.0.0.1:7801').replace(/\/+$/u, '')
const token = args[1]
const prompt = args[2]
if (!token || !prompt) {
  console.error('usage: node tools/worker-client.mjs <endpoint> <token> <prompt> [--cwd <path>] [--timeout-ms <ms>]')
  process.exit(2)
}
let cwd
let timeoutMs = 120000
for (let index = 3; index < args.length; index += 1) {
  if (args[index] === '--cwd') cwd = args[++index]
  else if (args[index] === '--timeout-ms') timeoutMs = Number(args[++index])
}

const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

async function call(method, path, body) {
  const response = await fetch(`${endpoint}/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const payload = await response.json()
  if (!response.ok || payload.ok === false) throw new Error(`${response.status} ${payload?.error?.code}: ${payload?.error?.message}`)
  return payload
}

const hello = await call('GET', '/hello')
console.log(`worker: ${hello.worker.hostname} ${hello.worker.platform}/${hello.worker.arch} cwd=${hello.worker.cwd}`)
console.log(`model : ${hello.selection.provider}/${hello.selection.model}`)
const created = await call('POST', '/sessions', { cwd })
console.log(`session: ${created.sessionId} (cwd ${created.cwd})`)
await call('POST', `/sessions/${encodeURIComponent(created.sessionId)}/prompt`, { text: prompt })
const deadline = Date.now() + timeoutMs
let cursor = 0
for (;;) {
  const remaining = deadline - Date.now()
  if (remaining <= 0) {
    console.error('timed out waiting for the remote session')
    process.exit(1)
  }
  const waited = await call('GET', `/sessions/${encodeURIComponent(created.sessionId)}/wait?timeoutMs=${Math.min(remaining, 60000)}&afterSeq=${cursor}`)
  if (waited.text) console.log(waited.text)
  cursor = waited.nextSeq
  if (waited.idle === true) {
    console.log('\n=== idle ===')
    if (waited.lastAssistantText) console.log(waited.lastAssistantText)
    process.exit(0)
  }
}
