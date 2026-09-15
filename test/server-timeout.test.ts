import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

test("production server survives silent headers and SSE gaps and still cancels upstream", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "bridge-timeout-"))
  const authFile = path.join(directory, "auth.json")
  await writeFile(authFile, JSON.stringify({ "github-copilot": { type: "oauth", refresh: "offline-token" } }))
  // Isolate credentials and fetch interception from other tests. Exercise the
  // real startServer path: tests that build their own Bun.serve miss its defaults.
  const child = Bun.spawn([process.execPath, "-e", `
    import assert from "node:assert/strict"
    const realFetch = globalThis.fetch
    const calls = []
    let cancelled = 0
    const encoder = new TextEncoder()
    const frame = type => encoder.encode('data: ' + JSON.stringify({type, response:{id:'r',output:[]}}) + '\\n\\n')
    globalThis.fetch = async (url, init) => {
      if (!String(url).startsWith('https://api.githubcopilot.com/')) return realFetch(url, init)
      assert.equal(init.timeout, false)
      assert.ok(init.signal instanceof AbortSignal)
      if (String(url).endsWith('/models')) return Response.json({data:[
        {id:'native',supported_endpoints:['/responses']},
        {id:'claude',supported_endpoints:['/v1/messages']},
      ]})
      const body = JSON.parse(init.body)
      calls.push(body.model + ':' + (body.input || 'cancel'))
      if (body.input === 'headers') {
        await Bun.sleep(16000)
        return Response.json({id:'r',status:'completed',output:[]})
      }
      return new Response(new ReadableStream({
        start(controller) {
          let timer
          init.signal.addEventListener('abort', () => {
            cancelled++
            clearTimeout(timer)
            controller.error(init.signal.reason)
          }, {once:true})
          controller.enqueue(body.model === 'claude'
            ? encoder.encode('event: message_start\\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":1}}}\\n\\n')
            : frame('response.created'))
          if (body.input === 'gap') timer = setTimeout(() => {
            controller.enqueue(frame('response.completed'))
            controller.close()
          }, 16000)
        }
      }), {headers:{'content-type':'text/event-stream'}})
    }
    const {startServer} = await import(${JSON.stringify(new URL("../src/server.ts", import.meta.url).href)})
    const server = await startServer(0)
    const send = (body, signal) => realFetch(new URL('/v1/responses',server.url), {
      method:'POST',body:JSON.stringify(body),signal
    })
    try {
      await Promise.all([
        (async () => {
          const r = await send({model:'native',input:'headers'}, AbortSignal.timeout(25000))
          assert.equal(r.status,200)
          assert.equal((await r.json()).status,'completed')
        })(),
        (async () => {
          const r = await send({model:'native',input:'gap',stream:true}, AbortSignal.timeout(25000))
          assert.equal(r.status,200)
          assert.ok((await r.text()).includes('response.completed'))
        })(),
        ...['native','claude'].map(async model => {
          const controller = new AbortController()
          const r = await send({model,input:'cancel',stream:true},controller.signal)
          const reader = r.body.getReader()
          await reader.read()
          controller.abort()
          await reader.cancel().catch(() => {})
          reader.releaseLock()
        }),
      ])
      for (let i=0;cancelled<2 && i<100;i++) await Bun.sleep(10)
      assert.equal(cancelled,2)
      assert.equal(calls.length,4, 'no hidden HTTP retries')
      console.log('silent headers, silent SSE, native/Claude cancellation: passed')
    } finally { server.stop(true) }
  `], { env: { ...process.env, OPENCODE_AUTH_FILE: authFile }, stdout: "pipe", stderr: "pipe" })
  const watchdog = setTimeout(() => child.kill(), 30000)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(stdout).toContain("silent headers, silent SSE, native/Claude cancellation: passed")
  } finally {
    clearTimeout(watchdog)
    child.kill()
    await rm(directory, { recursive: true, force: true })
  }
}, 35000)
